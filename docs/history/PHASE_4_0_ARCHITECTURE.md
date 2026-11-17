# WOLV Phase 4.0 Architecture

## Purpose and current boundary

Phase 4.0 adds a persistent intelligence and control plane around WOLV's existing market and wallet application. It records provenance, runs bounded analysis, evaluates deterministic policy, and creates proposals for a user to review. It does not submit orders or transactions. The execution boundary remains blocked.

The application is a Next.js server-rendered/web application deployed to Vercel (`fra1`). PostgreSQL-backed store implementations already exist for browser trade intents and BAW execution/authentication records. Adapter code is not evidence that a database is configured or deployed: no `TEST_POSTGRES_URL` was available during this implementation, and no production database connectivity was established.

## Existing repository components inspected

- **Asset catalogue:** `lib/binance.ts`, `lib/rwaAssetResponse.ts`, and `lib/spotAssets.ts` provide Binance Web3 RWA catalogue and spot eligibility contracts. The new Binance adapter uses these for selected-asset metadata only.
- **Price and candle paths:** `lib/quotes.ts`, `lib/opportunityMonitor.ts`, and `lib/candles.ts` support existing UI analysis. The quote helper and existing display normalizers do not, by themselves, provide a verified provider timestamp and source contract suitable for durable historical evidence. The Phase 4.0 collector therefore does not convert them into trusted observations.
- **AI:** Existing AI-assisted functionality is separate from the new typed analysis provider. New analysis records concise explanations, evidence references, assumptions, risks, and conclusions, not hidden chain-of-thought.
- **Authentication:** Agent control routes reuse `authorizeBawWalletRequest` and the existing BAW browser-wallet session/authorized-wallet configuration. The `/agent` UI authorizes with a wallet message signature only; it is not transaction signing or trading consent.
- **Persistence:** `services/browserTradeIntentStore.ts` and `services/bawExecutionStore.ts` show existing PostgreSQL patterns. The new `services/agentMemoryStore.ts` uses a dedicated `WOLV_AGENT_DATABASE_URL`, falling back to `WOLV_TRADING_DATABASE_URL`.
- **Execution boundary:** Existing agent BAW approval, execution, and execution-reconciliation routes return explicit `403` responses during Phase 4.0. The control-plane proposal approval path ends in `EXECUTION_BLOCKED`.
- **Deployment:** Vercel functions are request-scoped. No always-running worker or database-backed scheduler is configured. The collector is a bounded request operation and is disabled by default; no continuous poller was added.

## Component boundaries

1. **Market data** — provider-specific adapters emit typed records with provider timestamps and provenance. The collector validates watchlist scope, freshness, and values before persistence. It must not infer executable prices from indicative values or stamp local ingestion time as provider time.
2. **Historical memory** — PostgreSQL stores versioned assets, observations, candles, agent runs/events, opportunities, analyses, evaluations, policies, policy decisions, proposals, and kill-switch state. Reads are structured and bounded; no vector store is used.
3. **Agent orchestration** — `AgentOrchestrator` coordinates one explicit, bounded request through collection, opportunity detection, analysis, policy evaluation, and proposal creation. State changes are validated and persisted as ledger events.
4. **AI reasoning** — a provider receives persisted/current evidence and returns a strict structured result. Evidence references are checked against supplied evidence. AI output cannot grant permission or override a policy refusal.
5. **Deterministic policy** — `lib/agentControlPlane.ts` applies configured asset/direction, amount/exposure, slippage, reference-deviation, session, balance, freshness, quote-expiry, permission-expiry, and emergency-stop checks. Missing decision inputs fail closed.
6. **Approval management** — proposals are immutable in material fields and hashed. The approval service binds approval to that proposal hash; expiration, rejection, revocation, and approval transitions are recorded. Approval always ends at `EXECUTION_BLOCKED`.
7. **Future execution infrastructure** — intentionally absent from this phase. No control-plane API invokes BAW execution, wallet signing, transaction broadcast, approvals, or a worker.

## Persistence model

The migration in `services/agentMemoryStore.ts` creates the following PostgreSQL entities and supporting indexes:

| Entity | Stored information and integrity |
|---|---|
| `wolv_agent_asset_history` | Versioned chain/token/ticker/platform metadata, decimals and share denomination when verified, source, observation time, block provenance, metadata JSON and hash. Changed metadata creates a new history row. |
| `wolv_agent_market_observations` | Price, optional reference/bid/ask/spread, currency, indicative-versus-executable kind, source, provider and ingestion timestamps, freshness, verification, provenance, and an idempotency key. |
| `wolv_agent_market_candles` | OHLCV where supplied, interval, provider timestamps, verification and provenance; unique by asset/interval/open/provider. |
| `wolv_agent_runs` | Agent and strategy/version, trigger, lifecycle state, configuration snapshot, start/end, and termination reason. A partial unique index prevents concurrent active runs for an agent. |
| `wolv_agent_events` | Sequenced event ledger with correlation, payload, provenance, and prior-event link. Database triggers reject ordinary updates and deletes. |
| `wolv_agent_opportunities` | Direction, strategy/version, evidence references, prices, spread, historical context, status, expiry, outcome, and deduplication key. |
| `wolv_agent_analyses` | Evidence references, model/version, concise explanation, recommendation, risks, invalidating conditions, and structured result. |
| `wolv_strategy_evaluations` | Evaluation window, sample count, expected/observed outcomes, metrics, and methodology. No metrics are synthesized by the UI. |
| `wolv_agent_risk_policies` / `wolv_agent_policy_decisions` | Versioned policy documents and immutable decision snapshots/refusal reasons. |
| `wolv_agent_proposals` | Intended action, quote reference if available, expected amounts, slippage limit, policy/analysis references, expiry, risks, proposal hash, and user decision. Material fields are protected by a database trigger. |
| `wolv_agent_control` | Emergency stop, monitoring/opportunity stop flags, reason, permission expiry, and update time. |

Migrations are initialized by the store using a PostgreSQL advisory lock. This migration has not been applied to a disposable or deployed PostgreSQL instance in this environment.

## Agent lifecycle and operational flow

The state machine includes `IDLE`, `INITIALIZING`, `MONITORING`, `OBSERVATION_RECORDED`, `OPPORTUNITY_DETECTED`, `ANALYZING`, `ANALYSIS_COMPLETED`, `POLICY_VALIDATION`, `POLICY_APPROVED`, `POLICY_REJECTED`, `PROPOSAL_CREATED`, `AWAITING_USER_APPROVAL`, `USER_APPROVED`, `USER_REJECTED`, `EXPIRED`, `EXECUTION_BLOCKED`, `COMPLETED`, `FAILED`, and `STOPPED`.

Transitions are checked before persistence. Runs recover stale in-progress records as failed after the configured five-minute recovery age when a new bounded run starts; they do not resume analysis from an unverified checkpoint. Reconstruction validates event ordering and previous-event linkage. User approval applies only to the exact proposal hash and then records `USER_APPROVED → EXECUTION_BLOCKED → COMPLETED`.

## Market collection and opportunity detection

`MarketDataCollector` accepts an explicit watchlist (bounded to 25 assets per run), stores versioned catalogue metadata and observations/candles only after validation, and reports provider-specific failures. `WOLV_MARKET_COLLECTOR_ENABLED` defaults to `false`. The current Binance adapter synchronizes metadata only; it does not fetch durable price observations or candles with verified provider timestamps. Consequently, no live market opportunity or live proposal flow is established.

The initial deterministic detector compares normalized share-price evidence across venues, enforces freshness and verification requirements, records thresholds/evidence/rejections, and deduplicates opportunities. A price spread is not treated as guaranteed profit. No automatic 480-asset polling was introduced.

## Request APIs and interface

Authenticated routes are grouped under `/api/agent/control`, `/policy`, `/proposals`, and `/run`; read routes expose persisted activity and reconstructable run records. They use the existing wallet-session authorization path. `/agent` displays stored observations, opportunities, analyses, policy decisions/refusals, proposals, and controls. Its proposal decisions are records only. The interface must distinguish stored facts from unconfigured or unavailable capabilities.

The operator can explicitly enable orchestration for a bounded run and set a time-limited permission. The collector and orchestrator both remain disabled by default. Emergency stop persists globally, expires pending proposals, revokes active permission, and stops unfinished runs. Restarting does not silently re-enable a permission.

## Deployment requirements and limits

- Configure a TLS PostgreSQL database for `WOLV_AGENT_DATABASE_URL` (or intentionally use the documented `WOLV_TRADING_DATABASE_URL` fallback), apply/verify migrations, and test backup/restore and retention.
- Keep `WOLV_AGENT_CONTROL_PLANE_ENABLED=false` and `WOLV_MARKET_COLLECTOR_ENABLED=false` until operator-reviewed data adapters, timestamps, limits, and database availability are established.
- Add a separately deployed persistent scheduler/worker only if bounded scheduled collection is later required. Do not use an indefinitely running loop in a Vercel function.
- Establish and test provider rate limits, retries, staleness policies, provenance, and storage costs before enabling live collection.
- No production database, persistent worker, continuously operating agent, or execution capability is established by local tests.
