# WOLV Phase 4.0 Agentic Control Plane Report

## 1. Executive summary

Phase 4.0 establishes implementation foundations for a PostgreSQL historical-memory store, bounded collector interface, deterministic opportunity/policy logic, typed AI-analysis contract, persisted run/event lifecycle, proposal/approval management, and a quote/transaction-execution-blocked `/agent` control interface.

The phase is **incomplete**. The store migration was not exercised against PostgreSQL, no provider currently supplies verified provider-timestamp prices/candles to the collector, the production build could not fetch the existing Geist Google font due to network timeouts, and there is no deployed database or persistent worker evidence. The final decision is **A. AGENTIC_CONTROL_PLANE_INCOMPLETE**.

## 2. Existing architecture inspected

- Next.js 16 App Router deployed/configured for Vercel region `fra1`; request handlers are not persistent workers.
- PostgreSQL store patterns exist in browser trade-intent and BAW execution services, but no configured `TEST_POSTGRES_URL` was available. Adapter code alone does not establish a deployed database.
- Existing Binance Web3 RWA catalogue and compliance contracts are in `lib/binance.ts`, `lib/rwaAssetResponse.ts`, and `lib/spotAssets.ts`.
- Existing display/market-analysis paths include `lib/quotes.ts`, `lib/opportunityMonitor.ts`, and `lib/candles.ts`. The current paths do not establish the provider timestamp/provenance needed for durable verified observations in the new control plane.
- Agent control routes reuse `authorizeBawWalletRequest` and existing browser-wallet session authorization. UI message signing is for session authorization only, not a transaction signature.
- Existing agent BAW execution, approval, and execution reconciliation routes are blocked for Phase 4.0.

See [PHASE_4_0_ARCHITECTURE.md](./PHASE_4_0_ARCHITECTURE.md) for boundaries and persistence design.

## 3. New system architecture

The control plane separates market-data adapters, PostgreSQL memory, orchestration, AI analysis, deterministic policy, user approval, and future execution infrastructure. AI output is descriptive and cannot grant permissions. Missing/stale market evidence or policy context fails closed. The future execution boundary is not wired into this workflow.

## 4. Database schema

`services/agentMemoryStore.ts` contains a versioned PostgreSQL migration for asset metadata history, observations, candles, runs, append-only events, opportunities, analyses, strategy evaluations, risk policies, policy decisions, proposals, and emergency control state. It adds indexes for asset/time, run/status, event sequence, opportunity expiry, analysis history, policy decisions, and proposals.

The schema includes idempotency/deduplication keys, a single-flight active-run index, event sequence/previous-event references, an append-only event trigger, and immutable proposal material fields. The migration and SQL behavior remain **IMPLEMENTED_NOT_DEPLOYED** and not integration-tested.

## 5. Historical memory implementation

The memory service implements typed write/query contracts, metadata versioning, observation and candle deduplication, bounded pagination, time/asset/strategy queries, event reconstruction checks, opportunity outcome updates, policy refusal queries, and stale-run closure. Events are appended in database transactions for lifecycle and approval operations.

Actual PostgreSQL behavior—including migration compatibility, trigger semantics, transaction isolation, concurrent runs/approvals, pagination, and recovery—was not verified because `TEST_POSTGRES_URL` was unavailable.

## 6. Market ingestion

`MarketDataCollector` is bounded, validates selected assets, provider timestamps, freshness, and observation values, and remains disabled unless `WOLV_MARKET_COLLECTOR_ENABLED=true`. `BinanceAgentMarketAdapter` synchronizes selected-asset catalogue metadata only. It does not provide verified provider-timestamp price or candle observations. No unbounded polling or full-catalogue subscription is present.

Status: collector mechanics are **MOCKED_ONLY** in deterministic fixtures; live verified price/candle ingestion is **BLOCKED_EXTERNAL_DEPENDENCY**. No external provider was called by the automated tests.

## 7. Agent lifecycle and state machine

`AgentOrchestrator` performs one bounded operator-requested run. Transitions are checked and persisted. Starting a new run closes records older than the five-minute recovery threshold fail-safe; reconstruction verifies event sequence and previous-event references. Run recovery resumes nothing from an uncertain checkpoint.

The orchestration wiring is fixture-tested. PostgreSQL recovery and reconstruction remain unverified. It is not a background worker.

## 8. Opportunity detection

The deterministic initial strategy compares fresh verified cross-venue normalized share-price evidence, captures strategy thresholds and supporting observation identifiers, records rejection reasons, deduplicates by detection key, and expires opportunities. It does not infer guaranteed profit. The live adapter currently does not supply the required trusted price observations, so live opportunities are not established.

## 9. AI analysis

The typed analysis service validates structured results, evidence references, and supplied facts; malformed output, unavailable providers, stale/missing evidence, and timeouts fail explicitly. It stores a concise explanation, evidence references, risks, assumptions, limitations, and invalidating conditions, not hidden chain-of-thought.

Provider behavior is tested with mocked fixtures only. No live model call or calibrated performance claim was made.

## 10. Deterministic policy enforcement

Policy validation and evaluation enforce approved assets/directions, exact-decimal order and daily exposure caps, maximum slippage/reference deviation, market session, minimum balance, quote expiry, data freshness, policy permission expiry, and emergency stop. Decisions preserve policy version, input snapshot hash, timestamp, acceptance, and exact refusal reasons. AI cannot override a refusal.

Policy logic and API validation are fixture-tested. A production policy is not configured or activated.

## 11. Proposal and approval management

Proposals bind their material parameters with a stable hash; material fields are database-protected from ordinary updates. Approval is bound to the exact proposal hash. Rejection, expiration, and revocation are represented separately. An approval always records the terminal execution boundary and never submits a transaction.

The mocked API/workflow tests verify approval ends at `EXECUTION_BLOCKED` and no execution stub is called. No real approval or transaction was performed.

## 12. Emergency controls

The persisted control record defaults to emergency stop, monitoring stop, and opportunity rejection. Explicit enablement is time-limited. Activating emergency stop persists an event, clears permission, expires pending proposals, and stops unfinished runs. New runs check the persisted control state. No process-independent worker is running.

Emergency API behavior is fixture-tested; its durable PostgreSQL behavior is not integration-tested.

## 13. User interface

`/agent` now presents the control plane: persisted activity and filters, observations, opportunities, analyses, policy/refusal data, proposals, and operator controls. Proposal approval is clearly execution-blocked. The UI uses existing wallet session authorization and does not sign a transaction.

The UI is a data-backed interface, not a substitute for provider observations or persistent deployment. With no configured database it cannot demonstrate durable activity.

## 14. Deployment requirements

`WOLV_AGENT_DATABASE_URL` is documented in `.env.example` and falls back to `WOLV_TRADING_DATABASE_URL`. `WOLV_AGENT_CONTROL_PLANE_ENABLED` and `WOLV_MARKET_COLLECTOR_ENABLED` default to `false`. The existing Vercel configuration identifies a region only; it does not configure a background worker or database-backed scheduler.

Before any deployed use, configure and verify PostgreSQL, run migrations, add a trusted timestamped observation adapter, define provider limits/retention, and deploy a bounded scheduler if needed. No production operation is claimed.

## 15. Files changed for Phase 4.0

- Added: `lib/agentControlPlane.ts`
- Added: `services/agentMemoryStore.ts`
- Added: `services/marketDataCollector.ts`
- Added: `services/binanceAgentMarketAdapter.ts`
- Added: `services/agentAnalysis.ts`
- Added: `services/agentOrchestrator.ts`
- Added: `services/agentControlHttp.ts`
- Added: `components/AgentControlPlane.tsx`
- Added: `app/api/agent/control/route.ts`
- Added: `app/api/agent/policy/route.ts`
- Added: `app/api/agent/proposals/route.ts`
- Added: `app/api/agent/run/route.ts`
- Added: `scripts/agent-control-plane.test.mjs`
- Added: `docs/PHASE_4_0_ARCHITECTURE.md`
- Added: this report
- Updated: `app/agent/page.tsx`
- Updated: `app/api/agent/approve/route.ts`
- Updated: `app/api/agent/execute/route.ts`
- Updated: `app/api/agent/executions/route.ts`
- Updated: `lib/agentTelemetry.ts`
- Updated: `.env.example`

Other modified or untracked files in the worktree belong to prior phases or pre-existing work and are not attributed to Phase 4.0 here.

## 16. Regression and validation results

- `pnpm test:logic`: **PASS**, 383 tests reported; 382 passed, 0 failed, 1 skipped. The PostgreSQL-dependent execution case was skipped.
- Focused `scripts/agent-control-plane.test.mjs`: **PASS**, 19 tests including mocked API/auth, policy, disabled collection, timeout/malformed AI responses, opportunity workflow, approval-to-blocked behavior, and legacy execution-route blocks.
- `pnpm exec tsc --noEmit`: **PASS**.
- `pnpm lint`: **PASS**, 0 errors and 6 warnings in existing unrelated files.
- `pnpm test:hardening`: **PASS**.
- `pnpm build`: **BLOCKED**. Next.js could not fetch the existing Geist font from Google Fonts; network connection timed out (`ETIMEDOUT`). No font or build configuration change was made to hide this external dependency failure.
- PostgreSQL integration: **NOT RUN**; `TEST_POSTGRES_URL` is not configured.

## 17. Limitations

- PostgreSQL migration and persistence have not been tested against a disposable database.
- No deployed database or durable worker/scheduler was verified.
- No live trusted provider-timestamp market price/candle adapter is available to this workflow.
- End-to-end live opportunities, historical comparisons from production records, and proposals are not established.
- AI output was tested with fixtures, not a live provider.
- Production build did not complete because an existing remote font dependency was unreachable.
- Existing six lint warnings remain outside the Phase 4.0 change set.

## 18. Remaining blockers and Phase 4.1 recommendations

1. Provision a disposable PostgreSQL database and test migration, idempotency, append-only constraints, transactions, concurrent run protection, approval binding, emergency stop, and reconstruction/recovery.
2. Provision and verify a managed PostgreSQL deployment, backups, retention, and operational monitoring before enabling the control plane.
3. Implement a provider-specific adapter with verified timestamps and provenance for prices/candles; confirm rate limits and data semantics before enabling collection.
4. Add a separately deployed bounded scheduler/worker only after provider and persistence constraints are reviewed.
5. Add an end-to-end integration test from persisted observation through policy rejection/proposal and restart reconstruction.
6. Restore network access or use an approved local font asset, then rerun the production build; do not treat the timeout as a successful build.
7. Keep all execution routes blocked until a separately reviewed future phase explicitly changes that boundary.

## 19. Final decision

**A. AGENTIC_CONTROL_PLANE_INCOMPLETE**

Persistent memory schema and agent workflow foundations are implemented, but database persistence, trusted live market ingestion, deployment, and recovery behavior are not demonstrated end to end. Execution remains disabled and blocked. This decision does not authorize trading or autonomous execution.

## Capability classification

| Capability | Classification |
|---|---|
| Deterministic state machine, policy logic, and guardrails | `IMPLEMENTED_AND_TESTED` (unit/fixture level) |
| API auth and input validation, controls, proposal decision boundary | `IMPLEMENTED_AND_TESTED` (mocked API level) |
| PostgreSQL schema/store and transactional operations | `IMPLEMENTED_NOT_DEPLOYED` |
| Agent workflow using controlled records and mock providers | `MOCKED_ONLY` |
| Live timestamped market collection/opportunity detection | `BLOCKED_EXTERNAL_DEPENDENCY` |
| Production database, persistent worker, and operational recovery | `NOT_IMPLEMENTED` |
| Real transaction execution | `NOT_IMPLEMENTED` and explicitly blocked |
