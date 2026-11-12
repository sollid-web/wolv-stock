# WOLV Autonomy — Engineering Handover

Updated: 12 November 2026
Repository: sollid-web/wolv-stock
Implementation branch: autonomy/rebuild-from-hackathon-baseline
Pull request: #9 (draft; not merged)
Current trading worker mode: PAPER_ONLY
Live recovery worker mode: RECONCILIATION_ONLY

## Objective

Upgrade WOLV from a human-approved trading interface into a policy-driven autonomous system. Routine eligible trades should not require a person to approve each order. A person authorizes the custody wallet and capital envelope, and can revoke or stop the strategy. Deterministic code enforces limits on every action. The LLM is not the risk engine and cannot override wallet policy, token allowlists, budgets, slippage limits or emergency controls.

## Current verified state

- The connected Supabase project has 26 WOLV migrations applied. All 26 migration files in this branch use the exact recorded version/name pairs; a test guards against migration filename drift.
- The existing public.tokenized_market_pulse table was left intact with its four existing rows.
- The WOLV autonomy, paper-ledger and live-execution tables are server-only and RLS-enabled. Anonymous and authenticated roles cannot access private execution records.
- Live portfolio controls include atomic order/position/daily-loss/budget caps, native BNB reserve checks, explicit RFQ settlement sender/router allowlists and a global kill switch.
- Durable live attempts bind owner, intent, wallet, token pair, expected input/minimum output, RFQ quote/order IDs, payload hash, stable UUIDv4 request ID, policy version and immutable vendor sender/router allowlist snapshots. Provider fills must match the persisted order ID, exact input and minimum output; chain settlement must match the provider fill. State transitions are versioned and audited. Signatures and raw typed data are not persisted.
- A policy-gated live-entry orchestrator now sequences quote qualification, atomic reservation, durable attempt creation, Privy EIP-712 signing, exact-order simulation, gas preflight and Binance submission without per-trade human approval. It is not yet wired into a continuously running live-entry worker because a verified vendor-specific RFQ simulation capability is still missing.
- A separate reconciliation-only worker polls Binance RFQ status by the pre-persisted provider order ID, verifies BSC receipts and ERC-20 wallet deltas against immutable per-attempt sender/router allowlists, and commits a live fill only after independent chain settlement. It never creates or submits a new order.
- Settlement recovery continues while the new-entry kill switch is engaged. The kill switch still blocks new live entries.
- The live portfolio is not configured. The global kill switch remains engaged. There are no live attempts, fills, positions or exits, and no real order has been signed or submitted.
- Privy EIP-712 policy binding and a Node SDK adapter are implemented. The adapter validates BSC domain, vendor, verifying contract, exact type/message schema, wallet/tokens/amounts/expiry, stable signer-operation ID and recovered signer address. The @privy-io/node dependency, app credentials and wallet authorization are not installed/configured.
- The exact Binance RFQ typed-data schema still requires a real, non-broadcast fixture. A vendor-specific RFQ simulation capability is also missing; the live database requires fresh simulation proof after signing and before submission.
- Tests have been added but have not been executed in a local checkout. No claim of passing tests or production readiness is made.

## Implemented components

### Market data and opportunity discovery

- Supabase/PostgreSQL-backed market-price latest/history cache.
- Binance RWA market-price collector and freshness-aware API.
- Reference-price dislocation scanner and market-opportunity API.
- Market signals are research-only until fresh executable quotes are obtained.

### Paper trading and risk

- Persistent execution intents, event audit history, compare-and-swap state transitions and worker leases.
- Binance BSC RWA RFQ quote parsing, buy/reverse-sell quote validation and conservative round-trip edge calculation.
- Paper budget reservations, atomic paper fills, paper positions, take-profit/stop-loss/max-holding-time exits and realized paper P&L.
- Portfolio hard stops for order size, per-token position, daily spend, maximum open positions/orders, daily realized loss and optional native gas reserve.
- Global kill switch is engaged by default. Risk-reducing paper exits are not blocked by the new-entry stop.

### Live execution foundations

- Live portfolio schema and atomic live budget reservation/release RPCs.
- Durable live attempt table and immutable audit-event table.
- Stable request IDs, provider order IDs persisted before submit, signer-operation references, prepared payload hashes, versioned state transitions and recovery queries.
- Retry after ambiguous submission is limited to the same request ID and only within the recorded provider idempotency window. Once the window expires, blind resubmission is rejected.
- Signing requires a durable signer operation ID, a prepared-payload fingerprint and a signer address matching the wallet bound to the quote.
- Provider-filled and chain-settled are distinct states. The database requires actual amount, transaction, fee and block evidence before SETTLED; actual input and minimum output must match the pre-bound intent.
- The recovery worker is available as npm run autonomy:live-recovery-worker. It reconciles existing orders and settlement only; it is not a new-order worker.
- The RFQ settlement verifier checks BSC chain, vendor sender/router allowlists, transaction receipt status, confirmation depth, wallet token transfer deltas and actual gas fee.
- A Privy Node SDK adapter is present behind an injected client interface. It uses a server-side authorization context and stable idempotency key; no Privy wallet or credential is connected.

### Provider integrations

- Legacy Binance round-trip adapter remains the only provider used by the paper worker.
- Provider-neutral normalized contracts and registry include Binance and 1inch Classic, but the normalized registry is not yet used by the worker.
- 1inch Classic still needs full tax/honeypot, USD gas-fee, price-impact, approval target, simulation and settlement evidence integration before it can be used for autonomous execution.
- BSC RPC provides read-only chain checks, gas/native/ERC-20 balance reads, ordinary EVM transaction simulation and receipt/transaction lookup.
- Ordinary EVM transaction simulation does not automatically simulate Binance vendor-executed RFQ typed-data orders.

## Remaining gates before unattended live trading

1. **Privy runtime and custody.** Add and lock the official @privy-io/node dependency, instantiate the client in the server runtime, configure the Privy app and authorization key, and explicitly authorize a dedicated capped BSC execution wallet. No wallet may be created, imported, funded or enabled without that authorization.
2. **Real Binance RFQ schema.** Capture a fresh unsigned RFQ payload using the actual target vendor and wallet. Confirm the EIP-712 domain, verifying contract, primary type, all message fields, nonce, expiry, spender and token/amount binding. Opaque hex typed-data payloads remain rejected by the signer.
3. **RFQ simulation.** The live database requires exact-order simulation proof after signing and immediately before submission. The existing BSC eth_call/eth_estimateGas simulator handles ordinary EVM transactions, not Binance vendor-executed RFQ typed-data orders. Implement a documented vendor-specific RFQ simulation/preview endpoint or a validated signed-order simulation route. Do not fabricate a simulation fingerprint.
4. **Live entry orchestration.** Wire live policy load, fresh round-trip quotes, atomic live budget reservation, durable attempt creation, Privy signing, RFQ simulation, submit and state persistence into a separate live-entry worker. It must remain disabled by default and respect the global stop.
5. **Live exits and P&L.** The live ledger currently supports BUY entry fills. A complete autonomous system also needs SELL exit reservations, policy checks, settlement accounting, realized P&L, loss stops and recovery for partially filled exits.
6. **Runtime validation.** Run the full test suite, type-check, lint and build locally; run provider fixtures and BSC settlement tests; then perform a small, capped, explicitly authorized pilot. No deployment has been performed.

## Recovery-only worker

Start with:

npm run autonomy:live-recovery-worker

Required server-side configuration:
- NEXT_PUBLIC_SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- BINANCE_API_KEY
- BINANCE_SECRET_KEY
- WOLV_AUTONOMY_OWNER_ID
- WOLV_BSC_RPC_URL
- Live portfolio sender/router allowlists containing verified vendor settlement addresses

This worker only reconciles already-persisted live attempts. It does not sign or submit new orders. It must not be treated as an autonomous trading worker.

## Supabase migration history

The connected Supabase project has 27 applied migrations. The branch contains these exact versioned files:

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
16. 20261112221718_add_live_execution_policy_and_ledger.sql
17. 20261112221811_correct_live_execution_budget_enforcement.sql
18. 20261112222211_require_live_order_simulation_proof.sql
19. 20261112222512_add_unbound_live_reservation_release.sql
20. 20261112222539_adjust_live_simulation_freshness_guard.sql
21. 20261112223108_add_live_settlement_contract_allowlists.sql
22. 20261112223218_bind_live_attempt_tokens_and_amounts.sql
23. 20261112223453_index_live_execution_fill_owner_intent.sql
24. 20261112223600_move_live_simulation_gate_to_pre_submit.sql
25. 20261112224003_enforce_live_fill_order_amount_binding.sql
26. 20261112224135_snapshot_live_settlement_allowlists.sql
27. 20261112224518_add_live_privy_wallet_id.sql

These migrations are already applied to the connected WOLV Supabase project. Verify the linked target and compare local/remote history before any push:

npx supabase migration list

For a fresh project only, after linking the intended project, apply migrations with:

npx supabase db push
npx supabase migration list

Never put the service-role key in source code, browser variables or chat.

## Local validation commands

Use the repository's Node.js version and installed dependencies:

npm install
npm run test:logic
npm run lint
npm run build

The tests cover execution-domain rules, Binance provider parsing, normalized provider contracts, BSC RPC and settlement verification, portfolio hard stops, paper exits, live execution recovery, Privy EIP-712 policy and migration-history alignment. They have not been executed in this environment.

## Operator safety

- Keep the global kill switch engaged until the dedicated wallet, policy, RFQ schema, simulation, settlement and recovery gates have been verified.
- Do not store private keys, seed phrases, Privy authorization keys, signatures or raw typed-data payloads in logs, source control or chat.
- The signer must enforce an independent default-deny policy. The WOLV strategy engine is an additional control, not the only control.
- Never enable live execution until signing, simulation, settlement, revocation, recovery and duplicate-order tests pass.
- No deployment, merge to main, wallet creation, wallet import, funding or live order submission has been performed.

## Related design documents

- docs/PRIVY_AGENT_SIGNER.md
- docs/RFQ_SIGNER_ACCEPTANCE_PLAN.md
- docs/AUTONOMOUS_EXECUTION_ARCHITECTURE.md
- docs/BINANCE_CAPABILITY_MATRIX.md
- docs/BSC_RPC_PREFLIGHT.md
- docs/ONEINCH_CLASSIC_ADAPTER.md
