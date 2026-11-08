# WOLV Autonomous Execution Architecture

**Status:** architecture proposal; no live execution enabled  
**Baseline:** `ef67f625b5a67b528761b7832cb27e52174fb5dd`  
**Implementation branch:** `autonomy/rebuild-from-hackathon-baseline`

## Objective

Move WOLV from a user-clicked spot-trading terminal to a continuously operating, policy-bounded trading agent. The agent should discover opportunities, evaluate them, enforce deterministic risk rules, execute eligible orders, verify settlement, and recover from faults without asking for routine trade-by-trade approval.

Human involvement remains appropriate for initial account authorization, changing risk policy, funding, revoking access, and exceptional security incidents. It must not be inserted as a routine confirmation step in the eligible trade path.

## Critical integration finding

Binance currently exposes three different products that must not be conflated:

- **Binance Web3 API:** market/RWA data, quotes, unsigned transaction construction, simulation and broadcast. It does not provide a user's signing authority.
- **Binance Agentic Wallet (BAW):** an isolated on-chain MPC wallet with Secure Auto Sign for supported transaction classes. This is the leading candidate for supported BSC swaps, but a durable, headless WOLV cloud-worker session is not yet proven.
- **Binance MCP Server / Agent OS:** a remote MCP integration for a Binance Agentic *exchange sub-account*. Binance's current docs require user confirmation for every trade, cancel and internal transfer. It has no withdrawal scope and is therefore unsuitable as WOLV's unattended execution rail.

WOLV must not use the Binance MCP Server as a workaround for BAW's on-chain signing limitations. See `BINANCE_CAPABILITY_MATRIX.md` for the evidence and provider decision.

## System planes

### 1. Market intelligence plane

Responsibilities:
- Ingest Binance RWA catalogue, token prices, underlying market data, candles, platform metadata and executable aggregator quotes.
- Add independent market and liquidity feeds where available; do not treat one venue's reference price as executable.
- Normalize assets into a canonical instrument model: chain, token contract, issuer/platform, underlying ticker, share ratio, decimals, trading status, market session, quote source and observation timestamp.
- Maintain freshness budgets and mark stale, missing, halted, closed-session or inconsistent data as ineligible.
- Detect candidate opportunities using deterministic spread, liquidity, price-impact, session-alignment and fee calculations.
- Produce an immutable evidence snapshot for every candidate so the strategy decision can be reconstructed later.

No market-data result is an order authorization. A spread is not guaranteed profit.

### 2. Agent / strategy plane

Use a long-running worker, not a browser tab and not a request-bound Next.js route, as the autonomous loop.

Worker cycle:
1. Read fresh market snapshots and current user policy.
2. Generate candidate opportunities.
3. Evaluate candidates with deterministic strategy rules.
4. Optionally ask an LLM to rank/explain candidates or suggest parameters inside a typed schema.
5. Pass the proposed action to the deterministic risk engine.
6. Reserve budget and create a durable execution intent before calling an execution provider.
7. Submit only if every policy and provider precondition passes.
8. Reconcile order and chain state until a terminal state is proven.
9. Persist decision evidence, execution events, fees and realized outcome.

The LLM is not the risk engine, wallet, signer, transaction validator or source of truth. It cannot expand permissions, raise limits, override policy, select arbitrary recipients, or directly broadcast transactions.

### 3. Execution plane

Define provider interfaces so WOLV is not coupled to one Binance product:

- `MarketDataProvider`: read-only prices, RWA metadata, candles and market status.
- `QuoteProvider`: executable quote with source, route, expiry, fees, impact, amount and token identity.
- `ExecutionProvider`: provider-specific order or transaction submission.
- `SettlementProvider`: order status, transaction receipt, balance deltas and terminal settlement evidence.

Initial provider policy:
- Binance Web3 API is a data/quote/transaction-preparation provider, never a signer.
- BAW is an execution candidate only for documented supported operations where Secure Auto Sign actually returns a no-confirmation execution path.
- Binance MCP Server can be integrated later as an optional supervised CEX adapter; its confirmation-before-every-write behavior is not autonomous.
- A separate delegated smart-account/session-key provider may be evaluated for custom BSC contracts if BAW cannot execute the required route. It must enforce spending and contract permissions on-chain or in a separately audited signer boundary; EIP-7702 alone is not a complete risk policy.

### 4. Risk and policy plane

Risk rules must execute in ordinary deterministic code, independent of model output. Initial policy fields:

- Allowed chains, tokens, venues, routers and spend assets.
- Maximum order notional and maximum position per instrument.
- Maximum total deployed capital and daily spend/loss.
- Maximum slippage, price impact, quote age and gas cost.
- Minimum liquidity / route quality and minimum expected edge after fees.
- Market-session and instrument-status restrictions.
- Per-user cooldown, maximum concurrent orders and daily order count.
- Daily loss stop, drawdown stop and global emergency stop.
- Explicit strategy enablement and policy version.

Any missing, stale, malformed or contradictory input fails closed. Policy changes require explicit user authorization and are versioned. The worker cannot edit policy to make a rejected trade pass.

### 5. Persistence and job runtime

The current baseline is a Next.js application and does not yet establish a durable autonomous worker database/queue. Before unattended execution, add a persistent store and job runtime with:

- Durable execution-intent and event records.
- Per-user / per-wallet tenant isolation.
- Unique idempotency keys for strategy intent and provider submission.
- Worker leases and heartbeat to prevent concurrent execution.
- Outbox/inbox pattern for reliable provider calls and webhook/poll events.
- Encrypted provider credentials/session references; never store raw secrets in logs.
- Append-only audit trail for strategy version, input snapshot, policy version, quote, simulation, provider response and settlement.
- Recovery after worker crash, deploy, timeout, rate limit or provider outage.

Do not rely on in-memory queues, process-local locks, browser state, or a Vercel request handler as the durable scheduler. The storage/queue technology should be selected after inspecting the deployment and existing persistence choices; do not introduce a second database without a reason.

## Execution state machine

Routine eligible trades do not transition to a human-approval state.

```text
DISCOVERED
   -> QUALIFIED
   -> RISK_APPROVED
   -> BUDGET_RESERVED
   -> QUOTED
   -> SIMULATED (where supported)
   -> SUBMISSION_PENDING
   -> SUBMITTED
   -> SETTLEMENT_PENDING
   -> SETTLED

Any stage may instead transition to:
   REJECTED_POLICY
   EXPIRED
   PROVIDER_REJECTED
   FAILED
   UNKNOWN_REQUIRES_RECONCILIATION
   SECURITY_HOLD
```

Rules:
- Persist the intent and idempotency key before the external write.
- Validate exact chain, from/to, token addresses, amount, spender, recipient, calldata, quote expiry and slippage.
- Simulate the exact transaction payload that will be signed where the provider supports simulation.
- Never retry an ambiguous submission until the provider and chain have been reconciled.
- A provider order ID or `success: true` is not settlement.
- Settlement requires a terminal order state and, for on-chain trades, a successful receipt plus expected token balance deltas.
- Release reserved budget only after terminal reconciliation.
- A policy breach is rejected automatically; an authorization/session anomaly enters SECURITY_HOLD and disables further writes.

## User experience

The dashboard should expose:
- Agent status: stopped, shadow, paper, active, degraded or security hold.
- Strategy and policy version.
- Capital allocation, available budget, daily spend/loss and open exposure.
- Candidate decisions, including rejected candidates and machine-readable reasons.
- Live order lifecycle and settlement evidence.
- Provider/session health and last successful reconciliation.
- Emergency stop and revoke/disconnect controls.

The dashboard is observability and policy management; it is not required to remain open for the worker to operate.

## Rollout gates

1. **Provider discovery:** prove approved BAW trusted-agent onboarding and whether a remote worker can retain a valid session without a user-operated local process. No funds.
2. **Read-only agent:** continuously discover and rank candidates; record decisions but do not create orders.
3. **Shadow mode:** generate intended orders and compare predicted route, price and outcome against market data; no signer access.
4. **Paper execution:** exercise order state machine, idempotency, restarts and reconciliation against simulated fills.
5. **Test environment:** test provider behavior only where the actual provider supports a test chain/environment. Do not assume BAW supports BSC testnet.
6. **Capped live pilot:** only after explicit user enablement, provider proof, audited policy, emergency stop and end-to-end settlement tests. Use a separately funded, low-value wallet and hard limits.
7. **Scale:** expand token/venue/strategy scope only after measured reliability and risk review.

## Immediate engineering sequence

1. Keep the existing read-only Binance probe and add quote retrieval once a public wallet address is configured.
2. Build provider contracts and a deterministic execution state machine with mocked providers; test retries, duplicate intents, stale quotes, policy rejection and ambiguous submission.
3. Build the durable persistence/worker layer after confirming current deployment infrastructure.
4. Conduct BAW trusted-agent and Secure Auto Sign proof-of-capability outside the production WOLV wallet flow.
5. Implement the BAW adapter only if the supported session and unattended operation requirements pass.
6. If BAW cannot support the required autonomous route, evaluate a dedicated policy-enforcing smart-account/session-key signer. Do not weaken the product back to manual approval on every trade and do not bypass Binance controls.

## Non-goals for this phase

- No production signing or broadcasting.
- No automatic wallet funding or withdrawals.
- No arbitrary contract calls through BAW Developer Mode.
- No LLM-controlled limit changes or signer access.
- No deployment or merge to `main`.


## First implementation slice: deterministic execution domain

The branch now contains a provider-independent domain module at `services/autonomy/execution-domain.ts` and tests at `scripts/autonomy-execution-domain.test.mjs`.

Implemented in this slice:
- Typed execution intent and lifecycle states.
- Explicit transition graph; terminal states cannot be reopened.
- Monotonic event timestamps and version increments.
- Deterministic policy evaluation for enabled state, chain/token allowlists, order size, projected position, daily spend, gas budget, quote age, slippage, price impact and minimum expected edge.
- Integer-string / `bigint` comparisons for token amounts; no floating-point arithmetic for base-unit amounts.
- Explicit rejection codes suitable for UI and audit records.
- Ambiguous submissions are marked for reconciliation and are never eligible for blind retry.

Validation command:
```bash
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test scripts/autonomy-execution-domain.test.mjs
```

This is a pure domain layer only. It does not persist intents, reserve real balances, contact a provider, sign, broadcast, or execute trades. Those capabilities must be added behind separately tested storage, budget-reservation and execution-provider interfaces. The tests have been committed but have **not** been run in this environment; run the command locally before treating them as passing.


The provider/storage boundary is now also captured in `services/autonomy/execution-contracts.ts`:
- Atomic `createIfAbsent` for owner-scoped idempotency.
- Version-checked compare-and-swap to prevent stale workers overwriting state.
- Atomic budget reservation/release contracts.
- Append-only audit event contract.
- Separate quote, simulation, execution and reconciliation provider contracts.
- Distributed worker lease / heartbeat contract.

These are TypeScript contracts, not connected implementations. A real database and queue/lease backend must implement the atomicity guarantees before a worker is allowed to submit orders. Provider responses explicitly distinguish submitted, rejected and unknown outcomes; unknown outcomes must be reconciled, never blindly retried.
