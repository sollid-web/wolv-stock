# WOLV × Binance Agentic Wallet — Integration Audit

**Preflight (all read-only):** skill v1.15.0 current · CLI v1.12.0 current · `baw wallet status` → `CONNECTED` · no files modified, no transactions executed · existing logic tests re-run clean (110 pass / 0 fail, `npm run test:logic`).

---

## 1. What already works

**Live trading flow (browser-wallet signed, no custody changes):**
- Quote pipeline: `/api/quote` validates address/amount, enforces the $5 USDT minimum (`lib/apiValidation.ts:7-8`), gates on spot-only RWA membership (`lib/spotAssets.ts:123-137`), validates route math and the reference-price gap (`lib/quoteValidation.ts:74-88`), then issues an HMAC quote binding with a 30 s TTL (`lib/quoteBinding.ts:4`).
- Execution: `/api/swap` re-verifies the binding and the swap destination against the quoted spender (`app/api/swap/route.ts:29,52-57`); the browser simulates via `/api/transaction-simulate` before signing; RFQ signatures are forwarded via `/api/order/submit` after server-side eligibility re-checks. Execution gating is presentation + wallet enforced (`lib/tradeReadiness.ts:90-107`, `components/TradeButton.tsx:351,473,535`).
- Credentials are server-only: `BINANCE_API_KEY`/`SECRET_KEY` read in `lib/binance.ts:17-18` and used for HMAC request signing and the quote binding — never `NEXT_PUBLIC_`, never touched by client code.
- Guardrails that exist as *working library code with tests*:
  - `services/agentWorker.ts` — interval evaluation, stale-market rejection (`:294`), pause/revocation/cap checks (`:305-328`), price-trigger intent creation, duplicate-intent prevention, panic-stop after 3 consecutive failures with high-priority alert (`:424-453`).
  - `services/agentExecutor.ts` — live-submission kill switch (`:204-209`), **hard block of BSC mainnet** (only chain 97 allowed, `:211-216`), intent revalidation incl. staleness and 0.5 BNB cap (`:370-396`), on-chain validator preflight, receipt polling, structured telemetry.
  - `lib/smartAccount.ts` — ZeroDev Kernel v3.1 setup, hook-contract cross-validation (router/EntryPoint/chain/WBNB, `:431-455`), fee-adjusted PancakeSwap V2 quote with price-impact ceiling (`:225-265`), 5-minute deadline.
  - Test suite covers all of this: 110 tests across `scripts/agent-executor.test.mjs`, `agent-worker.test.mjs`, `smart-account.test.mjs`, `trade-readiness.test.mjs`, etc.
- BAW skill installed at `.agents/skills/binance-agentic-wallet` (symlinked from `.claude/skills`), pinned in `skills-lock.json`; CLI surface confirmed (`baw --help`).

## 2. What is incomplete / broken

| Gap | Evidence |
|---|---|
| **AgentWorker/AgentExecutor are dead code** — imported by nothing in `app/`, `components/`, `hooks/`; only tests reference them | grep over `app/ components/ lib/ hooks/` returns zero hits |
| `/api/agent/status` fetches `…/api/agent` — **a route that doesn't exist** | `app/api/agent/status/route.ts:118` vs. only `execute/` + `status/` under `app/api/agent/` |
| **Homepage shows fabricated telemetry**: mock 7-day volume, mock "trade executed" logs labeled "Live feed" | `app/api/agent/status/route.ts:54-91`, `AgentDashboard` rendered in `app/page.tsx:7` and `components/Homepage.tsx:433` |
| `/agent` is preview-only: mock trigger evaluation, no persistence, no scheduler, no execution | `app/api/agent/execute/route.ts:111-130`; README confirms |
| ZeroDev path is single-token, testnet-only, ephemeral-session, and locally unconfigured: `.env.local` has only the three Binance/WalletConnect vars — no `NEXT_PUBLIC_CHAIN_ID`, bundler URL, `NEXT_PUBLIC_POLICY_HOOK_ADDRESS`, or `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS` | `.env.local` contents; `lib/smartAccount.ts:159-199` |
| Executor requires a hand-supplied authorization resolver; session-key grant/persistence UX doesn't exist | `services/agentExecutor.ts:73,219`; README line 83 |
| **No persistence layer at all** (no DB dependency in `package.json`, no storage code) — durable strategy state, execution logs, and idempotency records have nowhere to live yet | grep for prisma/drizzle/sqlite/postgres/redis: empty |
| No authentication on any API route — `/api/agent/execute` is publicly callable | all routes under `app/api/` |
| BAW wallet is connected but **empty** (zero balances on all chains, dust-inclusive query also empty) | `baw wallet balance --hideLowValue false` → `[]` |
| BAW session is 48 h max / 48 h inactivity sign-out, expires 2026-11-01 19:14 (+01:00) | `baw wallet settings` |

## 3. ZeroDev vs. BAW — comparison and ownership of signing

| Dimension | ZeroDev path (existing) | BAW CLI path (proposed) |
|---|---|---|
| Custody | **User-owned smart account**; ephemeral in-memory session key granted per account | **Operator wallet in the Binance App**, one session per host, controlled by whoever can run `baw` on that machine |
| Signing | Browser/executor signs via bundler (ERC-4337 UserOperation) | CLI submits; confirmation via the signed-in Binance App session and wallet security settings |
| On-chain enforcement | Policy hook: route, recipient, min-out, selector, 0.5 BNB/trade, 1 BNB rolling cap, guardian pause/revoke (`lib/smartAccount.ts:377-493`) | None on-chain — policy is app-side limits (dailyLimit $50k, AutoReject, allowed-token list) + whatever WOLV enforces in code |
| Chain support | BSC testnet only (hard block on 56) | BSC mainnet 56 (and 6 other chains) |
| Venue | PancakeSwap V2, one fixed WBNB→target route | Binance aggregator, multi-route; quote output has **no vendor/price-impact/destination fields** to verify pre-sign |
| Fit | Per-user delegated autonomy (the "guardrails" story already built) | Operator-delegated execution; multi-user impossible — one CLI session = one wallet |

**Incompatibility:** they cannot own the same flow — one intent must be signed exactly once. **Duplication:** both need the same quote-validation, spot-filter, cap, telemetry, and panic-stop layers; WOLV already owns all of those and they must be reused rather than reimplemented around the CLI.

**Recommended division of ownership:**
- **ZeroDev executor remains the signing owner for user-facing autonomous execution** (it is the only path compatible with per-user custody and WOLV's on-chain policy hook). Phases 1–2 don't change this.
- **BAW becomes a separate, explicitly-labeled operator-agent execution adapter** (Phase 3+), gated server-side, single-flight, and never presented as the user's wallet. If a per-user delegated autonomous mode is ever needed, it goes through ZeroDev sessions, not the CLI.

## 4. Recommended architecture

```
Browser (Next.js on Vercel)  ── no BAW code, no session data, no wallet-control ability
        │  HTTPS only
        ▼
Next.js API routes (server)  ── sanitization, WOLV policy, quote binding, evidence store
        │  shared-secret auth (server-to-server)          ▲ DB / durable state (new)
        ▼                                                 │
BAW execution service (persistent host, NOT Vercel)  ─────┘
  • `baw` installed locally, session established once by the operator via QR
  • execFile-based wrapper: fixed command allowlist, structured args, timeouts
  • single-flight serialization (one CLI session must not race itself)
```

- **Vercel serverless cannot host `baw`**: the session is machine-local, sign-in requires a human QR scan, and the 48 h expiry needs a re-auth workflow. Any BAW integration must run on a long-lived host (worker/VM/container). This is a hard architectural constraint, not a preference.
- Phases:
  - **Phase 1 (read-only):** `GET /api/agent/wallet` → sanitized `{connected, addresses, chains, balances, settings-subset, quota}`. Never return pairing codes, session data, or raw CLI JSON that could carry unexpected fields.
  - **Phase 2 (quote-only):** `POST /api/agent/quote` → `baw market-order quote`, then re-apply *all* WOLV gates: spot eligibility, $5 minimum, reference-gap check (BAW's quote must be converted into the same `validateQuote` shape), 30 s TTL, HMAC binding. Display-only response.
  - **Phase 3 (approved execution):** one-time approval token bound to the quote binding; user clicks execute; server runs the security pre-check (token audit), `baw market-order swap`, then **polls `market-order list --orderId` to `FINISHED`/`FAILED`** — an orderId alone is not success (skill `market-order.md:59-69`). Record full evidence: orderId, txHash, actual received amount, refunds (partial fills).
  - **Phase 4 (guarded autonomy):** wire `AgentWorker` → durable strategy store → intent queue → executor adapter (ZeroDev default; BAW optional adapter). Emergency stop = worker halt + refuse new intents + (operator action) `baw auth signout` / guardian pause. Reuse `createWorkerFailureReporter` and the existing telemetry schemas.

## 5. Files that would need to change

**New:** `services/bawCli.ts` (execFile wrapper, arg validation, output schemas, single-flight); `app/api/agent/wallet/route.ts`; `app/api/agent/quote/route.ts`; execution/evidence types + record layer; durable-state adapter; client panel on `/agent`.

**Modify:** `app/api/agent/status/route.ts` (fix dead `/api/agent` fetch; stop serving mock volume/logs, or label them demo-only); `components/AgentDashboard.tsx` (same); `services/agentWorker.ts` + `services/agentExecutor.ts` (extract an executor interface so the worker can drive either backend); `lib/quoteValidation.ts` / `lib/quoteBinding.ts` (reuse for BAW quotes); `lib/agentStrategies.ts` (amount-unit mapping BNB↔USDT); `.env.example` (server-only `BAW_*` vars, no `NEXT_PUBLIC_`); `README.md` / `TRADING_ARCHITECTURE.md`; a DB choice for durability (none exists today).

## 6. Security risks and required safeguards

1. **Single-wallet blast radius.** The CLI session lets *any process on that host* trade from one wallet within the $50k daily limit. Safeguards: dedicated execution host, no public route maps user input 1:1 to a swap without auth + one-time approval, WOLV-side caps stricter than wallet settings (BAW has no on-chain hook to back it up).
2. **Command injection.** Never `exec`/shell; `execFile` with arrays; strict address regex + decimal-amount validation before any arg is constructed.
3. **Credential/session hygiene.** The CLI stores its own session token — never read, copy, or log it; never store it in the DB; never expose via API. Nothing BAW-related goes into a `NEXT_PUBLIC_` var. `lib/quoteBinding.ts` deriving HMAC from `BINANCE_SECRET_KEY` is already correct in shape — keep BAW out of client reach.
4. **Unverifiable destination.** Unlike `/api/swap` (where the tx destination is checked against the quoted spender), BAW market orders give no pre-sign destination. Rely on Binance's own routing + post-trade txHash evidence + the token-audit pre-check; do not invent a false sense of verification.
5. **Multi-user ambiguity.** BAW execution spends the *operator's* wallet. UI must say so explicitly, or users will believe their connected wallet is trading.
6. **Replay/idempotency.** Approval token single-use, bound to the exact quote binding; reject duplicate submissions.
7. **Prompt injection / untrusted data.** Token symbols/names come from on-chain and API data — never interpolate them into CLI args (addresses only).
8. **Fail-closed everywhere.** CLI missing, non-zero exit, unparseable JSON, disconnected session, audit API unreachable → no order, structured error.
9. **Availability vs. safety.** 48 h session expiry halts execution until a human re-scans — treat as an operational fact (and an accidental kill switch), not a bug.
10. **Today's mock data is a trust liability.** The homepage's fake "trade executed" logs must be replaced or clearly labeled before any real execution data is displayed alongside them.

## 7. Tests required before production

- **Unit:** CLI arg builder rejects injection vectors, bad addresses, non-decimal amounts; output parser handles every documented response shape; quote mapping passes `validateQuote` and fails on reference-gap/minimum/TTL violations; order state machine (`PENDING→FINISHED/FAILED`) incl. partial-fill `refund` parsing; duplicate approval-token rejection.
- **Integration (offline):** a fixture `baw` stub binary exercised through the route handlers; concurrency test proving single-flight; disconnected-session and timeout paths fail closed; auth gate on every new route.
- **Regression:** keep the 110 existing tests green; executor mainnet-block test must stay.
- **Manual (later, small amounts, operator-approved):** real `quote` → `swap` → order-status → receipt evidence cycle on BSC mainnet with a dust amount; session-expiry recovery drill; emergency-stop drill.

## 8. Smallest safe next step

**Phase 1 only**: add `services/bawCli.ts` (read-only commands: `wallet status`, `wallet address`, `wallet chains`, `wallet balance`, `wallet settings` via `execFile`, with output schemas and an offline-stub test) plus `GET /api/agent/wallet`, and a sanitized wallet panel on `/agent`. In the same change, stop `app/api/agent/status` from serving mock "live" logs (label or remove). No write commands, no swap code, no DB.
