# WOLV Autonomous Execution Architecture

**Status:** partially implemented; durable two-sided Binance RFQ quotes, deterministic portfolio risk checks, atomic paper-budget reservations and quote-based paper fills are implemented on the autonomy branch. Live EIP-712 signing, RFQ submission and settlement reconciliation are not enabled.  
**Baseline:** `ef67f625b5a67b528761b7832cb27e52174fb5dd`  
**Implementation branch:** `autonomy/rebuild-from-hackathon-baseline`

## Objective

Move WOLV from a user-clicked spot-trading terminal to a continuously operating, policy-bounded trading agent. The agent should discover opportunities, evaluate them, enforce deterministic risk rules, execute eligible orders, verify settlement, and recover from faults without asking for routine trade-by-trade approval.

Human involvement remains appropriate for initial account authorization, changing risk policy, funding, revoking access, and exceptional security incidents. It must not be inserted as a routine confirmation step in the eligible trade path.

## Critical integration finding

Binance currently exposes three different products that must not be conflated:

- **Binance Web3 API:** market/RWA data, quotes, unsigned transaction construction, simulation and broadcast. It does not provide a user's signing authority.
- **Binance Agentic Wallet (BAW):** an isolated on-chain MPC wallet with Secure Auto Sign for supported transaction classes. It may support some ordinary BSC swaps, but WOLV's RWA strategy uses Binance RFQ orders that require EIP-712 `sign-message`. Binance's current Agentic Wallet skill requires a preview, risk display and explicit user confirmation before external signing; even when `requireConfirmation=false` permits direct execution, the documented agent workflow still requires that confirmation. Developer Mode also expires. That is not an unattended signing path.
- **Binance MCP Server / Agent OS:** a remote MCP integration for a Binance Agentic *exchange sub-account*. Its trade/cancel/internal-transfer confirmation workflow is unsuitable for WOLV's unattended execution rail.
- **Delegated signer candidate:** Privy supports server-side EVM `signTypedData` and a policy engine that can constrain typed-data signatures, contracts and spend limits. It is a viable candidate for a separately authorized WOLV trading wallet, but wallet ownership, import/funding, policy configuration and BSC RFQ compatibility must be verified before adoption.

WOLV will not treat BAW Secure Auto Sign as RFQ signing authority or bypass its external-sign confirmation flow. The execution signer must be a dedicated, policy-constrained server signer authorized once by the wallet owner, not a browser session or a private key copied into worker environment variables. See `BINANCE_CAPABILITY_MATRIX.md` for the provider evidence.

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

The autonomy branch now adds a Supabase/Postgres-backed execution-intent queue, append-only event records, compare-and-swap updates and distributed per-intent leases. A separate migration adds fail-closed portfolio policy, atomic budget reservations, positions and idempotent paper-fill commit RPCs. Remaining persistence work includes:

- Live RFQ order preparation integration with the paper worker, exact EIP-712 signer, and idempotent submit/reconcile providers.
- Durable outbox/inbox handling for provider writes and reconciliation.
- Encrypted provider session references and rotation/revocation handling.
- Complete recovery paths for worker crash, provider timeout, rate limit and ambiguous order submission.

Do not rely on in-memory queues, process-local locks, browser state, or a Vercel request handler as the durable scheduler. The storage/queue technology should be selected after inspecting the deployment and existing persistence choices; do not introduce a second database without a reason.

## Execution state machine

Routine eligible trades do not transition to a human-approval state.

```text
DISCOVERED
   -> QUALIFIED
   -> QUOTE_REQUIRED
   -> QUOTED
   -> RISK_APPROVED
   -> BUDGET_RESERVED
   -> SIMULATED
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

The current paper worker reaches `QUOTED` and stops. It resumes persisted `DISCOVERED`, `QUALIFIED`, and `QUOTE_REQUIRED` intents after restarts, and records normalized quote evidence. It does not treat a reference-price dislocation as executable, does not fabricate zero gas or slippage, and does not mark a quote as risk-approved.

Rules:
- Persist the intent and idempotency key before external writes.
- Validate exact chain, from/to tokens, wallet, amount, route, quote expiry and slippage.
- Paper mode uses Binance's estimated network fee with a configurable buffer; live mode must validate the exact RFQ order payload and fee semantics before signing.
- Simulate the exact transaction or validate the exact RFQ typed-data order before signing.
- Never retry an ambiguous submission until provider and chain state have been reconciled.
- A provider order ID or `success: true` is not settlement.
- Settlement requires a terminal RFQ/order status and, for on-chain execution, a successful receipt plus expected token balance deltas.
- Release reserved budget only after terminal reconciliation.
- A policy breach is rejected automatically; authorization/session anomalies enter `SECURITY_HOLD` and disable further writes.

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

1. Build the portfolio ledger and atomic capital reservation layer in the existing Supabase database.
2. Calculate conservative expected edge from executable RFQ output, independent price references, token taxes, route fees and accurate gas; reject candidates without a trustworthy exit valuation.
3. Fetch accurate BSC gas price/limit, build the RFQ order, validate its typed-data domain and fields, and simulate supported steps.
4. Prove Binance Agentic Wallet Secure Auto Sign for the actual RFQ signing path, including approved trusted-agent onboarding, headless session persistence, expiry and revocation.
5. Paper quote fills and position accounting are implemented; validate them against the user's live Binance/Supabase environment before connecting any signer.
6. Only then evaluate capped live execution, with explicit user authorization, a hard kill switch and independently enforced wallet limits.

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

The provider contracts, Supabase/Postgres intent repository, worker leases, portfolio policy service and atomic paper ledger are implemented. The live RFQ signer/submission/reconciliation providers remain interfaces only. Provider responses distinguish submitted, rejected and unknown outcomes; unknown outcomes must be reconciled, never blindly retried.


## Implemented durable queue and paper qualification worker

The autonomy branch includes:
- Supabase-backed execution-intent records with owner-scoped idempotency.
- PostgreSQL compare-and-swap state updates and per-intent worker leases.
- Audit-event insertion in the same transaction as intent creation/state changes.
- A continuously polling paper-only worker that consumes fresh ACTIVE discount opportunities.
- Binance RWA RFQ quote retrieval and strict response validation; the worker records quote ID, expiry, vendor, route fingerprint, amounts, fees, gas estimate and safety metadata.
- Restart recovery for intents in `DISCOVERED`, `QUALIFIED` and `QUOTE_REQUIRED`.

The worker can progress from `QUOTED` through deterministic portfolio risk approval, atomic paper-budget reservation, `SIMULATED` and terminal `PAPER_FILLED`. Paper fills are quote-based simulations recorded in Supabase; they are not real orders, chain transactions or settlement. The worker still has no signer or live submission path. Binance network fees are estimates and receive a configurable default 2x buffer.

### Apply and configure

Apply all pending migrations, including the portfolio ledger migration after the execution queue migration:

```bash
npx supabase db push
```

Add server-only values to the worker environment (never expose the service-role key to the browser):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
WOLV_AUTONOMY_OWNER_ID=YOUR_OWNER_UUID
WOLV_AUTONOMY_WALLET_ADDRESS=0xYourBscWallet
WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS=0xYourInputToken
WOLV_AUTONOMY_ORDER_AMOUNT_BASE_UNITS=YOUR_ORDER_AMOUNT_IN_INPUT_TOKEN_BASE_UNITS
WOLV_AUTONOMY_POLICY_VERSION=paper-policy-1
WOLV_AUTONOMY_SLIPPAGE_BPS=50
WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS=10000
WOLV_AUTONOMY_ALLOWED_TOKEN_ADDRESSES=0xYourAllowlistedRwaToken
WOLV_AUTONOMY_PAPER_BUDGET_BASE_UNITS=YOUR_VIRTUAL_PAPER_BUDGET
WOLV_AUTONOMY_MAX_ORDER_BASE_UNITS=YOUR_MAX_ORDER
WOLV_AUTONOMY_MAX_POSITION_BASE_UNITS=YOUR_MAX_POSITION
WOLV_AUTONOMY_MAX_DAILY_SPEND_BASE_UNITS=YOUR_MAX_DAILY_SPEND
WOLV_AUTONOMY_MAX_SLIPPAGE_BPS=50
WOLV_AUTONOMY_MAX_PRICE_IMPACT_BPS=100
WOLV_AUTONOMY_MAX_QUOTE_AGE_MS=20000
WOLV_AUTONOMY_MAX_GAS_COST_USD=YOUR_MAX_NETWORK_FEE_USD
WOLV_AUTONOMY_MIN_EXPECTED_EDGE_BPS=100
BINANCE_API_KEY=YOUR_BINANCE_WEB3_API_KEY
BINANCE_SECRET_KEY=YOUR_BINANCE_WEB3_API_SECRET
```

Configure the owner-scoped paper policy. The setup command writes a disabled, emergency-stopped row by default:

```bash
npm run autonomy:configure-paper
```

After checking the allowlisted token, virtual budget, order/position/daily caps, slippage, price impact, quote age, fee cap and minimum edge, explicitly enable the paper agent:

```bash
npm run autonomy:configure-paper -- --enable-paper
```

The enable flag activates **paper mode only**. It does not authorize a live signer, submit a Binance order, or move real funds. Base-unit budgets and limits are denominated in the configured input token's smallest units. `WOLV_AUTONOMY_POLICY_VERSION` must match the portfolio row's policy version.

Run the worker only after migrations are applied and the market-price worker is producing fresh opportunities:

```bash
npm run autonomy:paper-worker
```

Do not run this as a browser process or expose the service-role key. With the portfolio migration applied and an enabled owner policy configured, the worker can create quote-based paper fills and update paper positions. It cannot create live transactions; live execution remains disabled.


## Current implementation boundary (2026-11-10)

Implemented on the autonomy branch:
- Supabase/Postgres persistence for intents, events and worker leases.
- Versioned state transitions and compare-and-swap writes.
- Opportunity qualification from cached market snapshots.
- Strict Binance RWA RFQ quote normalization and validation, including buy and reverse sell quotes for a round-trip edge.
- Strict unsigned RFQ `/swap` payload builder/parser, including EIP-712 metadata and approval detection; no signature or order submission.
- Worker progression from `QUOTE_REQUIRED` through two-sided RFQ validation, deterministic risk approval, atomic paper-budget reservation, quote simulation and `PAPER_FILLED` commit; restart recovery scans non-terminal intents.
- Exact decimal arithmetic for reference-price edge after token taxes, trade fees and an explicitly supplied gas USD cost.
- Supabase portfolio policy schema, fail-closed defaults, atomic reservation/release RPCs, and idempotent paper-fill/position commit RPCs.
- A read-only Binance capability probe; configured quote responses are summarized by field names and types only.

Not implemented or proven:
- Position holding/exit strategy, sell-side paper fills, mark-to-market and realized P&L.
- Live response validation in the user's Binance environment.
- Accurate gas/fee validation beyond Binance's estimated network fee, and conservative controls for non-atomic buy/sell execution.
- The worker and portfolio policy service are connected, but no owner portfolio has been configured and no paper fill has been observed in the user's Supabase environment.
- The worker now invokes the unsigned RFQ `/swap` builder when an enabled policy exists and records the order ID, vendor, EIP-712 format/hash and approval requirement. It does not sign or submit; no live signer or live order submission exists.
- A policy-constrained unattended EIP-712 signer authorized by the wallet owner; no signer provider is connected.
- On-chain submission, receipt verification, balance reconciliation or unattended recovery.

The Binance Web3 API is explicitly non-custodial: it returns unsigned transaction payloads or RFQ EIP-712 signing payloads and does not hold or access user private keys. Therefore, adding quote and transaction-build calls alone cannot make WOLV autonomous. A separately authorized signer remains a hard dependency. See the official [Binance Web3 API announcement](https://www.binance.com/en/support/announcement/detail/a9f19002d4584183b83892b002d61f96).


## Binance RWA quote adapter (2026-11-10)

The worker now calls the existing Binance Web3 aggregator quote endpoint through a generic BSC read-only adapter and validates the response before persisting a quote event.

Validation includes:
- BSC chain ID, wallet/token address formats, exact input token and amount, and exact output token.
- Successful provider envelope and a recent provider timestamp.
- Route quote ID, vendor, route string, and documented `RFQ` execution mode for equity/RWA assets.
- Positive output amount and gas estimate, non-negative estimated network fee, and explicit non-honeypot flags; token decimals and tax rates.
- Price-impact conversion to basis points with conservative upward rounding.
- A 20-second local expiry budget against Binance's documented approximately 30-second quote lifetime.
- SHA-256 fingerprints for route and quote evidence.

Important limitations:
- Binance documents `tradeFee` as a USD estimate and `estimateGasFee` as an estimate that may be inaccurate. The quote is therefore evidence for paper screening only, not sufficient for live execution. The paper worker applies a 2x default or owner-configured fee buffer and requires a fresh reverse RFQ quote; exact gas and live RFQ execution still require further provider validation.
- RWA routes return `RFQ`, not a normal router swap. The execution path must sign the returned typed data and submit the RFQ order, which is a distinct signer capability from broadcasting a standard swap transaction.
- Quote IDs expire quickly. WOLV records a conservative 20-second deadline and must obtain a new quote before any later build/submit stage if the deadline has passed.

The worker currently transitions through `DISCOVERED → QUALIFIED → QUOTE_REQUIRED → QUOTED → RISK_APPROVED → BUDGET_RESERVED → SIMULATED → PAPER_FILLED` when an enabled owner policy passes. `PAPER_FILLED` represents a simulated buy/entry and an indicative reverse quote; it does not represent a completed sell or realized profit. Remaining live-trading blockers are a policy-constrained EIP-712 signer, idempotent order submission, and settlement reconciliation.

Official endpoint contract: [Binance Trading API — Get Aggregated Quote and RFQ flow](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api).


## Portfolio policy and paper ledger

Migration `20261110150000_create_autonomy_portfolio_ledger.sql` adds an owner-scoped portfolio policy row, budget reservations, token positions and idempotent paper-fill records. The default policy is disabled, emergency-stopped, has zero paper budget and empty allowlists. It cannot trade until an owner-specific policy is deliberately configured.

The PostgreSQL reservation function serializes per-owner budget decisions, enforces token/chain allowlists, order/position/daily limits and total paper budget, and requires the execution intent to be in `RISK_APPROVED`. The paper-fill commit function requires a matching unexpired quote on an intent in `SIMULATED`, commits once per intent, and updates the position ledger atomically. These RPCs do not touch real wallet balances or submit transactions.

The server-only adapter is `services/autonomy/supabase-portfolio-ledger.ts`. It loads policy and exposure from Supabase and exposes reserve/release/commit operations. The worker now uses these operations for risk approval and paper fills. The migration has not been confirmed applied to the user's Supabase project.

The exact-decimal helper `services/autonomy/reference-edge.ts` computes net edge from the reverse RFQ output amount, stablecoin USD valuation and buffered network fees. When the portfolio migration is applied and an enabled policy row is configured, the worker evaluates both quote legs, position exposure, daily spend, order size, slippage, impact, fee cap and minimum edge before approving a paper fill. The buy and sell legs are not atomic; the reverse quote is a momentary liquidity check, not a guaranteed later fill.


## Unsigned RFQ order preparation

WOLV now has a separate read-only adapter for Binance `GET /api/v1/dex/aggregator/swap`. It requests `approveTransaction=false`, uses the same quote ID, wallet, token direction and input amount, and passes configured slippage and price-impact protection. The validator requires the response to remain in `RFQ` mode, checks the returned route and amounts against the original quote, checks the RFQ vendor and EIP-712 signing metadata, hashes the typed-data payload, and flags any auxiliary approval data.

The polling worker now calls this adapter when an enabled owner policy is present and stores only the order ID, signing scheme, typed-data hash/format and approval metadata. It does not persist the raw typed-data payload, sign it, submit an RFQ order, or broadcast a transaction. Binance's documented RFQ flow requires EIP-712 signing, then `POST /order/submit` with a UUID idempotency key, followed by polling the order status until `FILLED` or `FAILED`. The Binance API's request ID idempotency must be preserved across retries; ambiguous submissions must be reconciled rather than assigned a new request ID.


The portfolio policy includes `network_fee_buffer_bps` (default 10000 = 100% uplift) for Binance's estimated USD network fee. The worker loads this value and applies it to both legs before comparing the total against `max_gas_cost_usd` or calculating round-trip edge. This mitigates underestimation but does not turn Binance's estimate into an exact gas quote; missing fee data still fails closed.


The round-trip adapter is `services/autonomy/binance-roundtrip-provider.ts`. It requires the reverse quote's input amount to equal the buy quote's slippage-adjusted minimum output, rejects non-zero intermediate RWA transfer taxes until vendor tax treatment is verified, and fails closed if either quote or fee estimate is missing/stale. It applies a configurable network-fee buffer (worker environment variable `WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS`, default 10000 bps = 2x) to both estimated USD network fees. The portfolio table stores the same fee-buffer policy and the worker loads it when available; an environment default is used only when the portfolio row is not yet available. It does not claim atomic execution or guaranteed profit.


The paper-fill evidence migration (`20261110170000_extend_paper_fill_exit_evidence.sql`) adds the sell quote ID, minimum exit amount, round-trip edge, buffered network fees, slippage and exit-quote timestamp to each paper fill. The atomic commit RPC verifies both quote IDs and every stored round-trip field against the intent's immutable quote event before updating the paper position and budget.


**Important paper-mode boundary:** the current ledger opens paper positions and stores a contemporaneous indicative exit quote. It does not yet run a holding/exit strategy, execute paper sells, or calculate realized P&L. Do not interpret `PAPER_FILLED` as a closed profitable round trip.

## RFQ signer decision update (2026-11-11)

Privy's current wallet-infrastructure documentation confirms support for EVM typed-data signing and policy rules that can constrain typed-data domains and message fields. Its policy model supports explicit ALLOW/DENY rules, with DENY taking precedence. This strengthens Privy as the leading technical candidate for a bounded WOLV RFQ signer, but it is not yet an approved custody integration.

Important distinction: the current Binance RFQ parser accepts both JSON typed data and opaque hex payloads. Privy's `eth_signTypedData_v4` interface expects structured JSON typed data. WOLV must not pass an opaque hex payload into that method or infer its semantic fields. The exact Binance RFQ domain, primary type, verifying contract, order fields, nonce and expiry must be established from a real target-vendor response and checked against the official provider contract before a signer adapter can be written safely.

The existing Reown/Wagmi wallet connection is not automatically a server signer. A Privy wallet would have a distinct address unless the owner explicitly authorizes an appropriate signer/delegation arrangement for the exact wallet used in Binance's quote. Do not import a wallet key, create a replacement wallet, or move funds as part of this engineering phase.

See [RFQ Signer Acceptance Plan](./RFQ_SIGNER_ACCEPTANCE_PLAN.md) for the required payload, wallet-policy, signature-recovery, revocation and settlement gates. Until those gates are met, WOLV remains paper-only and does not claim unattended live execution.

## Paper position exits and realized P&L (2026-11-11)

WOLV now includes an opt-in paper exit lifecycle:
- Deterministic take-profit, stop-loss and maximum-holding-time decisions use integer base-unit arithmetic and basis points.
- Exit thresholds are portfolio policy fields and remain disabled by default. At least one explicit threshold is required before paper exits can be enabled.
- The worker reads open paper positions, obtains a fresh reverse-direction Binance RFQ quote, applies a conservative slippage haircut, output-token tax and buffered estimated network fee, then evaluates the configured exit policy.
- A new owner-scoped Supabase RPC locks the portfolio and position, prevents overselling, writes an idempotent paper-exit record, releases the proportional cost basis and updates paper committed capital atomically.
- A new-entry emergency stop does not block an explicitly configured risk-reducing paper exit. It still blocks new entry reservations.
- Partial-close accounting is supported by the ledger RPC; the current worker closes the full remaining paper position when an exit trigger fires.

This is still a **quote-based paper exit**, not an actual sale. The exit price is an RFQ observation and can change before a real order is submitted. Realized paper P&L is stored in the paper-exit ledger and is not a statement of wallet profit or loss. The new migration `20261111100000_create_paper_exit_ledger.sql` must be applied before the updated worker can run against Supabase. Existing portfolios remain exit-disabled until explicitly configured.

The paper config script accepts:
- `WOLV_AUTONOMY_PAPER_TAKE_PROFIT_BPS`
- `WOLV_AUTONOMY_PAPER_STOP_LOSS_BPS`
- `WOLV_AUTONOMY_PAPER_MAX_HOLDING_MS`
- `--enable-paper-exits` to explicitly enable the exit policy

The three thresholds are independently optional, but at least one must be supplied to enable exits. Exit policy configuration is separate from enabling new paper entries.

## Binance RFQ submit and chain-evidence adapters (2026-11-11)

WOLV now has a provider adapter for Binance's documented RFQ order lifecycle:
- Submit validates UUID v4 request IDs, 65-byte signatures, EIP-712 scheme, BSC chain and quote expiry.
- It forwards the exact Binance `rfq.orderId`, vendor and signature through the existing server-side Binance API module.
- Any transport exception or malformed acknowledgement is classified as `UNKNOWN`, because the provider may have accepted the order before the connection failed. A retry must reuse the same request ID.
- Status polling maps `PENDING_VENDOR` and `PENDING_ONCHAIN` to pending, and provider terminal failures to failed.
- A Binance `FILLED` response becomes `PROVIDER_FILLED`, not `SETTLED`.

A separate BSC transaction-detail verifier checks the transaction hash, BSC chain identifier, successful transaction status, wallet input-token transfer, wallet output-token transfer, exact expected amounts, block height and network fee. Only after that independent evidence is available may a higher-level orchestrator classify the execution as settled. The verifier contract requires the expected amounts from persisted order evidence; it does not infer them.

These adapters are provider building blocks, not an enabled live worker. The current worker still runs paper-only. No signing provider, durable live submission queue, or settlement state persistence has been wired into it. The live path remains blocked until the typed-data schema and wallet authorization are verified, and the end-to-end state machine persists the request ID before any submission.

Official Binance references:
- Trading API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api
- Submit RFQ Order: `POST /api/v1/dex/aggregator/order/submit`; Binance documents requestId idempotency for 30 minutes and requires the signing wallet to match the quote wallet.
- Get RFQ Order Status: `GET /api/v1/dex/aggregator/order/{orderId}`; provider statuses `FILLED` and `FAILED` are terminal, but provider fill still needs chain evidence for WOLV's ledger.
- Transaction Detail by Tx Hash: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/wallet-api

## Live-mode risk gaps

The paper portfolio currently enforces per-order and per-token position caps, daily entry spend, allowlists, quote age, slippage, price impact, estimated network fee and minimum edge. Before live mode, add deterministic daily realized-loss stops, max concurrent positions/orders, portfolio-wide concentration limits, a native-gas reserve floor and an operator-wide global kill switch. Paper exit P&L is recorded, but a daily loss stop is not yet computed from that ledger. These controls are release blockers for unattended live execution.
