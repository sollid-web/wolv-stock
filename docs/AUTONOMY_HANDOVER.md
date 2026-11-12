# WOLV Autonomy — Engineering Handover

**Updated:** 2026-11-12  
**Implementation branch:** `autonomy/rebuild-from-hackathon-baseline`  
**Repository:** https://github.com/sollid-web/wolv-stock  
**Execution mode in the current worker:** paper-only

## Objective

WOLV is being upgraded from a human-approved trading interface into a policy-driven autonomous system. Routine eligible trades should not require a person to approve every order. A person authorizes the wallet/capital envelope and can revoke or stop the strategy; deterministic code enforces limits on every action.

The LLM is not the risk engine and cannot override wallet policy, token allowlists, budgets, slippage limits or emergency controls.

## Implemented on this branch

- Supabase/PostgreSQL-backed market price cache and opportunity scanner.
- Persistent execution intents, event audit history, compare-and-swap state transitions and worker leases.
- Strict Binance BSC RWA RFQ quote parsing, buy/reverse-sell quote validation and conservative round-trip edge calculation.
- Unsigned Binance RFQ order construction and typed-data hashing/metadata validation.
- Owner-scoped paper portfolio policies, atomic budget reservation and paper entry fills.
- Restart recovery for non-terminal paper intents.
- Deterministic paper take-profit, stop-loss and maximum-holding-time rules, disabled by default.
- Conservative paper exit valuation, including slippage, output-token tax and buffered network-fee estimates.
- Atomic owner-scoped paper exit ledger with cost-basis release and realized paper P&L.
- Binance RFQ submit/status adapter and BSC transaction-detail settlement verifier as isolated provider building blocks.
- Provider registry used by the autonomous worker for entry round-trip quotes, unsigned order building and paper exit quotes; configured provider preference and fail-closed chain/configuration selection.
- Vendor-neutral quote/prepared-payload contracts, a normalized provider registry, and common-contract adapters for Binance RFQ and 1inch Classic. Provider fallback occurs before accepting a quote; quote evidence cannot be prepared by another provider.
- Read-only BSC RPC client for chain verification, gas/native/ERC-20 balance reads, exact unsigned EVM transaction simulation and mined receipt validation; an adapter exposes it through the common EVM simulator contract.
- Independent BSC Classic-swap settlement verifier that checks transaction sender/router/chain, confirmation depth, ERC-20 Transfer logs, exact input debit, minimum output credit and actual fee in wei.
- Tests covering domain rules, provider response parsers, exit calculations, migration safety and configuration.

The common-contract registry now registers both Binance and 1inch adapters (`WOLV_AUTONOMY_NORMALIZED_PROVIDER_ORDER`, default `binance-web3-aggregator,1inch-classic`). This registry is not yet used by the autonomous worker: the worker still uses the legacy Binance round-trip interface because 1inch does not yet satisfy the full two-sided tax, price-impact, USD gas-fee and settlement-evidence requirements. The BSC RPC simulator is also not yet wired into worker state transitions. See [AUTONOMY_PROVIDER_REGISTRY.md](./AUTONOMY_PROVIDER_REGISTRY.md), [ONEINCH_CLASSIC_ADAPTER.md](./ONEINCH_CLASSIC_ADAPTER.md), and [BSC_RPC_PREFLIGHT.md](./BSC_RPC_PREFLIGHT.md).

## Not yet production-ready

The current worker is deliberately paper-only. The following are still required before unattended live execution can be enabled:

1. **Signer:** No signer is connected. Binance RFQ may return an opaque hex payload or JSON typed data. The exact target-vendor EIP-712 domain, primary type, verifying contract, nonce, expiry and message fields must be verified before a signer may sign it. Privy is a candidate, not an approved or configured wallet.
2. **Custody authorization:** The server signer must control the exact wallet address used for Binance RFQ, or be explicitly authorized to sign for it. The existing browser Reown/Wagmi connection is not a server signer. No wallet was created, imported, funded or migrated.
3. **Durable live execution state:** The submit/status and settlement adapters are not yet wired into a live worker with a persistent request ID, provider order ID, signed-payload recovery, leases, and restart-safe reconciliation.
4. **Exact transaction simulation and settlement:** A provider `FILLED` status is not enough. The actual transaction receipt and token transfers must be independently verified and persisted before WOLV records a live fill.
5. **Runtime validation:** New code has not been run against the user's local environment, Supabase project or a live RFQ wallet. The most recent user-reported 67/67 test pass predates these changes.
6. **Deployment:** No deployment or production environment was changed.

Do not describe WOLV as autonomously trading real funds until these gates have been passed in a dedicated, explicitly authorized pilot.

## Supabase migrations

The branch adds these migrations:

1. `20261108090000_create_market_price_cache.sql`
2. `20261110100000_create_market_opportunities.sql`
3. `20261110120000_create_autonomous_execution_queue.sql`
4. `20261110150000_create_autonomy_portfolio_ledger.sql`
5. `20261110170000_extend_paper_fill_exit_evidence.sql`
6. `20261111100000_create_paper_exit_ledger.sql`
7. `20261112100000_add_autonomy_portfolio_hard_stops.sql`

Apply them only after verifying the linked Supabase project is the intended project:

```bash
npx supabase migration list
npx supabase db push
npx supabase migration list
```

If the CLI is not linked, authenticate and link the intended project first. Do not paste the service-role key into source code, browser variables or chat.

## Local validation commands

Use Node.js with native TypeScript type stripping support and the repository's installed dependencies:

```bash
npm install
npm run test:logic
npm run lint
npm run build
```

The test script runs `scripts/*.test.mjs`, including normalized provider registry, BSC RPC, EVM simulation, BSC ERC-20 settlement verifier, portfolio hard-stop, paper-exit and RFQ execution tests. These commands have not yet been run against the current branch.

## Paper worker configuration

The worker requires server-side environment variables, including:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server/worker only)
- `BINANCE_API_KEY`
- `BINANCE_SECRET_KEY`
- `WOLV_AUTONOMY_OWNER_ID`
- `WOLV_AUTONOMY_WALLET_ADDRESS`
- `WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS`
- `WOLV_AUTONOMY_ORDER_AMOUNT_BASE_UNITS`
- `WOLV_BSC_RPC_URL` (optional until the BSC RPC preflight/simulator is wired; remote endpoints must use HTTPS)

The paper portfolio configuration script also requires the budget, allowlists, max order/position/daily spend, slippage, price-impact, quote-age, gas-cost, network-fee-buffer and minimum-edge variables. It accepts `WOLV_AUTONOMY_MAX_OPEN_POSITIONS` (default 1) and `WOLV_AUTONOMY_MAX_DAILY_REALIZED_LOSS_BASE_UNITS` (default equal to max daily spend).

By default, configuration writes a disabled policy with the emergency stop active. `--enable-paper` enables paper entries only. Paper exits are separately opt-in with `--enable-paper-exits` and at least one configured threshold:
- `WOLV_AUTONOMY_PAPER_TAKE_PROFIT_BPS`
- `WOLV_AUTONOMY_PAPER_STOP_LOSS_BPS`
- `WOLV_AUTONOMY_PAPER_MAX_HOLDING_MS`

The paper worker command is:

```bash
npm run autonomy:paper-worker
```

The market data worker command is:

```bash
npm run market:worker
```

Running these commands is not required to review the source. Do not run them against production until migrations, environment, wallet address, allowlists and paper policy have been verified.

## Branch and merge status

- Work is isolated on `autonomy/rebuild-from-hackathon-baseline`.
- `main` has not been modified by this implementation.
- The implementation branch was created from the hackathon baseline commit `ef67f625b5a67b528761b7832cb27e52174fb5dd`.
- The repository's `main` has since advanced; compare and reconcile the branch against the current `main` before merging.
- Do not force-push, reset local changes, or merge to production without reviewing the resulting diff.

## Safety and operational rules

- No private keys, seed phrases, signer authorization keys or session files belong in logs, source control or chat.
- A signer must enforce an independent default-deny policy. The WOLV strategy engine is an additional control, not the only control.
- Unknown submission outcomes are not retryable as new orders. Reconcile first and reuse the exact request ID for retries of the same order.
- Emergency stop blocks new entries. Risk-reducing exits should remain available under a separately enabled, bounded exit policy.
- Paper fills and paper P&L are simulations, not wallet balances, real execution or realized on-chain profit.
- Never enable live execution until signing, simulation, settlement, revocation, recovery and duplicate-order tests all pass.

## Primary engineering references

- `docs/AUTONOMOUS_EXECUTION_ARCHITECTURE.md`
- `docs/BINANCE_CAPABILITY_MATRIX.md`
- `docs/RFQ_SIGNER_ACCEPTANCE_PLAN.md`
- `docs/MARKET_PRICE_CACHE.md`

## Review vehicle

A draft pull request is open at https://github.com/sollid-web/wolv-stock/pull/9. GitHub currently reports it as not mergeable. The implementation branch is 32 commits behind the current `main`; inspect and reconcile that divergence before merge.

## Additional risk controls still required before live mode

The owner policy and atomic reservation RPC now enforce order size, per-token position cost basis, daily spend, maximum concurrent token positions, daily realized paper-loss stop, chain/token/input-token allowlists, quote age, slippage, price impact, estimated network fee and minimum edge. Still required before live execution: maximum concurrent order count (separate from open positions), portfolio-wide exposure/concentration limits, a native-gas reserve floor, an operator-wide global kill switch, and a live-loss ledger based on independently settled trades. These controls must be deterministic and independently tested.

## Provider-neutral execution and BSC preflight update (2026-11-12)

The branch now contains:
- `services/autonomy/provider-contracts.ts`: normalized quote and prepared-payload types for EVM transactions and EIP-712 orders.
- `services/autonomy/normalized-provider-registry.ts`: configured-provider ordering, request/response binding and quote freshness checks. Fallback is attempted only before a quote is accepted.
- `services/autonomy/binance-execution-adapter.ts`: maps Binance's strict RFQ quote parser and unsigned RFQ order builder to the normalized contract.
- `services/autonomy/provider-registry.ts`: registers Binance and 1inch in the normalized registry, separately from the legacy registry used by the current paper worker.
- `services/autonomy/bsc-rpc.ts` and `services/autonomy/bsc-evm-simulator.ts`: read-only BSC chain checks, balance/gas reads, exact unsigned EVM simulation and receipt validation.

Tests added: `scripts/normalized-provider-registry.test.mjs`, `scripts/bsc-rpc.test.mjs`, and `scripts/bsc-evm-simulator.test.mjs`. They have **not** been executed in this environment. The BSC RPC layer has no signing or broadcast method. The worker remains paper-only; no signer, live queue, or live transaction path has been activated.

## Portfolio hard-stop update (2026-11-12)

Migration `20261112100000_add_autonomy_portfolio_hard_stops.sql` adds an atomic maximum-open-position cap and a daily realized-loss stop to the Supabase reservation RPC. The RPC locks the owner portfolio, counts distinct open/reserved token positions, sums negative paper-exit P&L for the UTC day, and rejects new reservations when either cap is reached. It also accepts both the legacy Binance round-trip audit event and the normalized provider event name; this prevents a quote-event naming mismatch from silently blocking reservation.

The portfolio service loads open-position count and daily realized loss into the deterministic risk candidate. `evaluateRiskPolicy` rejects missing loss evidence when the cap is configured, rejects new assets at the concurrent-position limit, and permits adding to an already-open position subject to its per-token cap. The database RPC independently repeats the hard-stop checks at reservation time.

Configuration: `WOLV_AUTONOMY_MAX_OPEN_POSITIONS` defaults to 1; `WOLV_AUTONOMY_MAX_DAILY_REALIZED_LOSS_BASE_UNITS` defaults to the configured daily spend cap and must fit within the paper budget. These limits are denominated in the configured input token's smallest units. They are paper-policy controls until a separate live policy and live ledger exist.

Risk snapshot retrieval uses `wolv_get_autonomy_risk_snapshot`, a database-side aggregate returning exact realized-loss text and distinct active positions. This avoids relying on a client-side paginated list for hard-stop decisions. The atomic reservation RPC repeats both caps while holding the portfolio row lock.

The BSC settlement verifier is an isolated capability. It is not yet connected to durable live-intent state or a signer, and its router target must be approved by an independent trusted-contract policy before use.
