# WOLV Autonomy — Engineering Handover

## Current verified status — 12 November 2026

- Supabase has 15 WOLV autonomy migrations recorded. All 15 migration files in this branch now use the exact versions/names recorded by the connected project, so the CLI history can be reconciled without replaying already-applied schema changes.
- The existing market-pulse tables were not modified. The autonomy and live-ledger tables are server-only, RLS-enabled, and inaccessible to anon/authenticated roles.
- The live-attempt ledger, immutable event log, signer/settlement evidence gates, and provider idempotency retry deadline are implemented and applied. The live tables are empty.
- The portfolio is not configured and the global kill switch remains engaged. No signer is connected, no live worker is wired, and no real order has been signed or submitted.
- Privy is now validated as the preferred technical route for EIP-712 server signing on EVM chains, including BSC. WOLV has a fail-closed EIP-712 policy adapter that checks the domain, verifying-contract allowlist, exact type schema, message fields, idempotency key, and recovered signer address. The Privy SDK transport and wallet are not connected or authorized; no wallet was created or funded.
- The exact Binance RFQ EIP-712 payload/domain still needs a captured, non-broadcast fixture before a Privy policy or signer can safely be activated.
- The latest code and migration tests have not been executed in a local checkout. No claim of passing tests or production readiness is made.

Next implementation reference: [Privy agent signer design](PRIVY_AGENT_SIGNER.md).


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

1. **Signer:** No signer is connected. Privy is the preferred technical route: a fail-closed EIP-712 adapter now validates BSC chain ID, allowlisted verifying contract, exact type schema, message shape, bound wallet/token/amount/expiry fields, stable idempotency key, and recovered signer address. The exact Binance RFQ domain, primary type and field paths still require a captured non-broadcast fixture. The Privy SDK transport and wallet remain unconfigured and unauthorized.
2. **Custody authorization:** The server signer must control the exact wallet address used for Binance RFQ, or be explicitly authorized to sign for it. The existing browser Reown/Wagmi connection is not a server signer. No wallet was created, imported, funded or migrated.
3. **Durable live execution state:** The Supabase live-attempt ledger and repository now persist UUIDv4 request IDs, provider/order metadata, payload hashes, signer operation IDs, state versions, immutable events, and a provider-specific retry deadline. They deliberately do not store signatures, raw typed data or raw transactions. The live worker, signer transport, submit/status adapters and settlement verifier are not yet wired together; no restart-safe live order path is active.
4. **Exact transaction simulation and settlement:** Read-only BSC RPC simulation and settlement-verification adapters exist, but they are not yet connected to the live worker. A provider `FILLED` status is not enough; the actual transaction receipt, token transfers, amount deltas, block and gas fee must be independently verified and persisted before WOLV records a live fill.
5. **Runtime validation:** New code has not been run against the user's local environment, Supabase project or a live RFQ wallet. The most recent user-reported 67/67 test pass predates these changes.
6. **Deployment:** No deployment or production environment was changed.

Do not describe WOLV as autonomously trading real funds until these gates have been passed in a dedicated, explicitly authorized pilot.

## Supabase migrations

The branch contains 15 migration files whose version prefixes and names match the connected Supabase project's applied migration history:

1. 20261112193035_create_market_price_cache.sql
2. 20261112193042_create_market_opportunities.sql
3. 20261112193048_create_autonomous_execution_queue.sql
4. 20261112193058_create_autonomy_portfolio_ledger.sql
5. 20261112193107_extend_paper_fill_exit_evidence.sql
6. 20261112193114_create_paper_exit_ledger.sql
7. 20261112193119_add_autonomy_portfolio_hard_stops.sql
8. 20261112193351_harden_autonomy_database_privileges.sql
9. 20261112193435_index_autonomy_foreign_keys.sql
10. 20261112193721_create_durable_live_execution_attempts.sql
11. 20261112193911_fix_live_execution_audit_redaction.sql
12. 20261112193943_fix_live_execution_audit_redaction_v2.sql
13. 20261112194033_enforce_live_submission_retry_window.sql
14. 20261112194235_enforce_live_execution_evidence.sql
15. 20261112194339_index_live_execution_event_owner_intent.sql

These migrations are already applied to the connected WOLV Supabase project. Before running a migration command, confirm the linked project and compare the local and remote histories:

```bash
npx supabase migration list
```

For a fresh project only, after linking the intended project, apply the migrations with:

```bash
npx supabase db push
npx supabase migration list
```

The migration-history alignment test fails if the local filenames drift from the applied versions. Do not rename these files without applying a corresponding migration-history repair. Never put the service-role key in source code, browser variables or chat.

## Local validation commands

Use Node.js with native TypeScript type stripping support and the repository's installed dependencies:

```bash
npm install
npm run test:logic
npm run lint
npm run build
```

The test script runs `scripts/*.test.mjs`, including normalized provider registry, Binance normalized adapter, Binance RFQ schema probe, BSC RPC, EVM simulation, BSC ERC-20 settlement verifier, portfolio hard-stop, global kill-switch, paper-exit and RFQ execution tests. These commands have not yet been run against the current branch.

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
- `WOLV_BSC_RPC_URL` (required when `WOLV_AUTONOMY_MIN_NATIVE_GAS_BALANCE_WEI` is greater than zero; remote endpoints must use HTTPS)

The paper portfolio configuration script also requires the budget, allowlists, max order/position/daily spend, slippage, price-impact, quote-age, gas-cost, network-fee-buffer and minimum-edge variables. It accepts `WOLV_AUTONOMY_MAX_OPEN_POSITIONS` (default 1), `WOLV_AUTONOMY_MAX_OPEN_ORDERS` (default 1), `WOLV_AUTONOMY_MAX_DAILY_REALIZED_LOSS_BASE_UNITS`, and `WOLV_AUTONOMY_MIN_NATIVE_GAS_BALANCE_WEI` (default 0, which disables the optional floor).

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

The owner policy and atomic reservation RPC now enforce order size, per-token position cost basis, daily spend, maximum concurrent token positions and outstanding reservations, daily realized paper-loss stop, optional native BNB gas reserve floor (checked through BSC RPC), chain/token/input-token allowlists, quote age, slippage, price impact, estimated network fee and minimum edge. The paper path also caps concurrent outstanding reservations separately from open positions. Still required before live execution: durable live-order count enforcement, portfolio-wide exposure/concentration limits, signer-boundary revalidation of native gas reserve, and a live-loss ledger based on independently settled trades. These controls must be deterministic and independently tested.

## Provider-neutral execution and BSC preflight update (2026-11-12)

The branch now contains:
- `services/autonomy/provider-contracts.ts`: normalized quote and prepared-payload types for EVM transactions and EIP-712 orders.
- `services/autonomy/normalized-provider-registry.ts`: configured-provider ordering, request/response binding and quote freshness checks. Fallback is attempted only before a quote is accepted.
- `services/autonomy/binance-execution-adapter.ts`: maps Binance's strict RFQ quote parser and unsigned RFQ order builder to the normalized contract.
- `services/autonomy/provider-registry.ts`: registers Binance and 1inch in the normalized registry, separately from the legacy registry used by the current paper worker.
- `services/autonomy/bsc-rpc.ts` and `services/autonomy/bsc-evm-simulator.ts`: read-only BSC chain checks, balance/gas reads, exact unsigned EVM simulation and receipt validation.

Tests added: `scripts/normalized-provider-registry.test.mjs`, `scripts/binance-execution-adapter.test.mjs`, `scripts/binance-rfq-schema-probe.test.mjs`, `scripts/bsc-rpc.test.mjs`, `scripts/bsc-evm-simulator.test.mjs`, `scripts/bsc-settlement-verifier.test.mjs`, `scripts/portfolio-hard-stops-migration.test.mjs`, and `scripts/autonomy-global-kill-switch.test.mjs`. They have **not** been executed in this environment. The BSC RPC layer has no signing or broadcast method. The worker remains paper-only. A durable live-attempt ledger exists, but no signer transport, live worker, order submission or live transaction path has been activated.

## Portfolio hard-stop update (2026-11-12)

Migration `20261112193119_add_autonomy_portfolio_hard_stops.sql` adds atomic maximum-open-position, maximum-outstanding-order and daily realized-loss stops to the Supabase reservation RPC. The RPC locks the owner portfolio, counts distinct open/reserved token positions, counts active reservations, sums negative paper-exit P&L for the UTC day, and rejects new reservations when any cap is reached. It also accepts both the legacy Binance round-trip audit event and the normalized provider event name; this prevents a quote-event naming mismatch from silently blocking reservation.

The portfolio service loads open-position count, outstanding-reservation count and daily realized loss into the deterministic risk candidate. `evaluateRiskPolicy` rejects missing evidence, enforces both concurrency limits, rejects new assets at the open-position limit, and permits adding to an already-open position subject to its per-token cap. The worker optionally checks the live wallet's BNB balance against the configured wei floor using BSC RPC. The database RPC independently repeats the concurrency and daily-loss hard stops at reservation time.

Configuration: `WOLV_AUTONOMY_MAX_OPEN_POSITIONS` and `WOLV_AUTONOMY_MAX_OPEN_ORDERS` both default to 1; `WOLV_AUTONOMY_MAX_DAILY_REALIZED_LOSS_BASE_UNITS` defaults to the configured daily spend cap and must fit within the paper budget; `WOLV_AUTONOMY_MIN_NATIVE_GAS_BALANCE_WEI` defaults to 0 (disabled). The realized-loss limit is denominated in the configured input token's smallest units; the native gas floor is denominated in wei. They are paper-policy controls until a separate live policy and live ledger exist.

Risk snapshot retrieval uses `wolv_get_autonomy_risk_snapshot`, a database-side aggregate returning exact realized-loss text and distinct active positions. This avoids relying on a client-side paginated list for hard-stop decisions. The atomic reservation RPC repeats all database-enforceable caps while holding the portfolio row lock.

The BSC settlement verifier is an isolated capability. It is not yet connected to durable live-intent state or a signer, and its router target must be approved by an independent trusted-contract policy before use.

## Operator-wide kill switch

Migration `20261112193119_add_autonomy_portfolio_hard_stops.sql` creates `wolv_autonomy_global_control` with the global kill switch engaged by default. The reservation RPC and paper-fill commit RPC read-lock this control row and refuse new entries/fills while it is engaged. The paper exit RPC is intentionally not blocked, so configured risk-reducing exits can continue.

Use the server-side command to engage the stop (default) or explicitly release it:

```bash
npm run autonomy:global-stop
npm run autonomy:global-stop -- --release
```

Release is an explicit operator action and should occur only after verifying the portfolio policy, provider health, RPC, signer status (for any future live mode) and intended operating environment. The command requires the Supabase service-role key on the server and writes an audit reason. No global switch was released as part of this implementation.

## Binance RFQ schema evidence

A safe read-only RFQ schema probe is available as `npm run autonomy:rfq-schema-probe`. It builds a fresh quote and unsigned RFQ order using local server credentials, then prints only schema metadata and hashes—not raw typed data. This is the next evidence step before a signer can be implemented. If the payload is opaque hex, the current policy deliberately rejects it.


## Connected Supabase deployment status — 12 November 2026

The connected Supabase project was inspected and all 15 WOLV autonomy migrations were applied. The migration files in this branch have been renamed to the exact versions and names recorded by Supabase; the history-alignment test prevents accidental filename drift.

Applied migration names:
- create_market_price_cache
- create_market_opportunities
- create_autonomous_execution_queue
- create_autonomy_portfolio_ledger
- extend_paper_fill_exit_evidence
- create_paper_exit_ledger
- add_autonomy_portfolio_hard_stops
- harden_autonomy_database_privileges
- index_autonomy_foreign_keys
- create_durable_live_execution_attempts
- fix_live_execution_audit_redaction
- fix_live_execution_audit_redaction_v2
- enforce_live_submission_retry_window
- enforce_live_execution_evidence
- index_live_execution_event_owner_intent

Verified database state:
- Existing public.tokenized_market_pulse remains intact with 4 rows.
- No autonomy portfolio is configured.
- Execution intents/events/leases: 0.
- Paper positions/fills/exits: 0.
- Cached prices/history/opportunities: 0.
- Live execution attempts/events: 0.
- Global kill switch: true, reason INITIAL_FAIL_CLOSED.
- No live order has been signed, submitted or broadcast.

Database hardening:
- WOLV security-definer functions use search_path = pg_catalog, public.
- The market-price trigger function is not directly executable by anon/authenticated roles.
- The three public market-data tables are SELECT-only for anon/authenticated roles; public writes are revoked.
- Execution, portfolio and live-attempt tables retain RLS with no client-facing policies; they are server/service-role only.
- Foreign-key indexes identified by the Supabase performance advisor have been added.

Latest Supabase advisor results:
- Security: only INFO findings for RLS-enabled autonomy tables with no policies. This is intentional; do not add browser policies without an explicit owner-scoped access design.
- Performance: no remaining unindexed-foreign-key finding. Remaining unused-index INFO findings are expected before the worker processes workload.

The migrations being applied does not mean the market-data workers are running, a portfolio is configured, or live execution is enabled. The global kill switch remains engaged.

## Database and live-recovery hardening — 12 November 2026

The connected Supabase project now has 15 recorded migrations applied for the WOLV autonomy workstream. This includes the existing market cache, opportunity scanner, paper execution/portfolio ledger, paper exits, database privilege hardening, FK indexes, and the live-attempt recovery ledger.

Verified database state:
- The existing market-pulse tables were left untouched.
- Market cache and opportunity tables retain read access for the application; anonymous/authenticated write privileges were revoked. Server routes use the service-role client.
- Autonomy, paper-ledger and live-execution tables have RLS enabled with no client-facing policies. The service role is the only application access path.
- The live-attempt and event tables are empty. No live execution has been initiated.
- The portfolio is not configured. The global kill switch remains engaged.
- The live transition RPC is executable by service_role, not anon or authenticated.
- The security advisor reports only informational RLS-without-policy findings for server-only autonomy tables. The performance advisor's unindexed-FK finding for the live event ledger was fixed with an owner/intent index. Unused-index findings are expected before workload traffic exists.

### Durable live-attempt ledger

New schema and service:
- wolv_live_execution_attempts stores a stable UUID v4 request ID, provider and wallet binding, quote/order identifiers, payload fingerprint, durable signer-operation reference, transaction hash, actual amounts, fee and settlement block.
- wolv_live_execution_events is append-only and records every status transition.
- Optimistic version checks and a database transition RPC prevent concurrent state corruption.
- A live attempt can only be inserted in PREPARED for an owner-scoped RISK_APPROVED intent.
- Signing transitions require a durable signer operation ID, a SHA-256 prepared-payload fingerprint, and a signer address matching the wallet bound to the quote.
- Provider-filled state requires a provider order ID, transaction hash and positive actual amounts.
- SETTLED requires transaction hash, actual input/output amounts, fee and block evidence; the database requires these values to match the provider-fill evidence.
- The event interface rejects signature material, typed data, private keys, raw transactions and calldata. No signature or raw signing payload is stored.
- An ambiguous submit can only be retried using the same persisted request ID while the provider idempotency deadline remains valid. Once it expires, the database rejects resubmission and requires reconciliation or a security hold.

The live ledger is scaffolding, not a live execution system. It is not wired into the worker and has no signer/custody provider. No real trades are possible through this path yet.

### Latest database verification

The database verification confirmed the live-attempt schema, RLS, service-role-only access, signer/settlement guards and empty live ledger. The latest security advisor run returned no ERROR/WARNING security findings; its remaining RLS-without-policy entries are intentional for server-only tables. The remaining performance INFO findings are unused indexes on tables that have not yet received workload traffic.
