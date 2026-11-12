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
- Tests covering domain rules, provider response parsers, exit calculations, migration safety and configuration.

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

The test script runs `scripts/*.test.mjs`, including the newly added paper-exit, RFQ execution and BSC settlement-verifier tests. These commands have not yet been run against the current branch.

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

The paper portfolio configuration script also requires the budget, allowlists, max order/position/daily spend, slippage, price-impact, quote-age, gas-cost, network-fee-buffer and minimum-edge variables described in `docs/AUTONOMOUS_EXECUTION_ARCHITECTURE.md`.

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

A draft pull request is open at https://github.com/sollid-web/wolv-stock/pull/9. It is not mergeable yet because the implementation branch is 32 commits behind the current `main`; reconcile and review that divergence before merge.
