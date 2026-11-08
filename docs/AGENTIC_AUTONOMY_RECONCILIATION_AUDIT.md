# WOLV Agentic / Autonomous Architecture Reconciliation Audit

**Branch:** `audit/agentic-autonomous-reconciliation`  
**Scope:** repository source and documentation review  
**Safety posture:** no live trading, signing, approvals, or broadcasts performed

## Executive finding

WOLV contains useful pieces of an agentic system, but they are not yet one integrated autonomous trading product. There are two distinct tracks:

1. **Phase 4 persistent control plane:** PostgreSQL-backed memory, bounded orchestration, deterministic policy decisions, proposal management, owner authorization, and a durable emergency stop. Its verified terminal state is `EXECUTION_BLOCKED`.
2. **Standalone ZeroDev worker/executor:** a threshold worker and a UserOperation dispatcher exist in source. Repository documentation says they are not connected to the `/agent` control-plane UI/workflow. No real testnet or mainnet UserOperation has been submitted.

The distinction is critical. A source-level executor, passing mocked dispatch tests, or configured feature flags do not prove that production scheduling, market-data ingestion, per-user authorization recovery, or autonomous execution is operational.

## Findings

| Priority | Finding | Evidence / impact | Required action |
|---|---|---|---|
| P0 | Do not enable autonomous live submission yet | Phase 4.0.1 verification explicitly closes with `C — AGENTIC_CONTROL_PLANE_OPERATIONAL_WITH_EXECUTION_DISABLED`. Proposal approval terminates at `EXECUTION_BLOCKED`. | Keep all live execution flags off. Require a separate security approval before any testnet-to-mainnet progression. |
| P0 | The worker/executor is not integrated with the product control plane | README and architecture docs state the standalone worker/executor are not connected to `/agent`; the worker needs injected market-data and owner-validator modules. | Define and implement a narrow adapter contract between persisted approved intents and the worker. Preserve owner, policy-hash, expiry, and kill-switch checks across the boundary. |
| P1 | Verified live market ingestion is incomplete | Phase 4 architecture says the Binance adapter synchronizes metadata only and does not fetch durable price observations/candles with verified provider timestamps. Collector defaults off. | Implement a provider adapter with provider timestamps, provenance, freshness bounds, deduplication, rate limiting, and failure telemetry. Do not substitute local receipt time for provider time. |
| P1 | Durable scheduling and production operations are not established | Phase 4 architecture states there is no production scheduler/always-on worker configured. Worker process entrypoint exists, but a process script is not a deployed scheduler or supervisor. | Add a separately deployed worker service, health/heartbeat, lease/lock semantics, restart recovery, bounded retries, alert delivery, and operator runbooks. |
| P1 | Delegated signer lifecycle is incomplete | README says executor authorization depends on an already granted in-memory session signer; persistence/recovery and session-grant UX remain separate. | Implement per-owner grant, durable encrypted recovery or deterministic reauthorization, expiry/revocation, key isolation, and recovery tests before connecting dispatch. Never introduce a global owner private key. |
| P1 | The DCA path intentionally cannot submit | `services/dcaExecutor.ts` returns `transactionSubmitted: false`; the autonomous-ready state still carries an execution-blocked result. | Keep this boundary explicit. Integrate only after the execution adapter and policy contract are reviewed and tested. |
| P1 | Market-data, strategy, and execution layers use different assumptions | Legacy worker strategies are threshold-based and consume injected snapshots; Phase 4 orchestration is evidence/proposal-oriented. They do not yet share a single persisted strategy schema or lifecycle. | Define one versioned strategy/intent schema and explicit state transitions. Add migration and compatibility tests before wiring layers together. |
| P1 | Spot-only product claims conflict with an advanced vault contract | The repository includes `WOLVAdvancedStrategyVault.sol` with spot and perpetual/short-related interfaces, while README/product positioning describes WOLV as spot-only. | Treat the vault as experimental/unintegrated until its deployment status, adapters, access controls, liquidation behavior, audits, and product scope are verified. Do not deploy based on source presence. |
| P2 | Calldata freshness documentation is contradictory | `DevReport.MD` says fresh swap calldata immediately before signing was fixed; README's trading-flow text says normal SWAP reuses prepared calldata and its limitations section says refresh remains outstanding. | Trace the actual SWAP signing call path, add a regression test that asserts a fresh payload is fetched after quote preparation and before wallet signing, then make README and DevReport agree. |
| P2 | README agent description had drifted from Phase 4 verification | Older local/mock-preview language sits alongside newer persistent control-plane claims and separate worker/executor claims. | This branch updates the agent section to describe the two tracks separately and link this audit. |
| P2 | Verification evidence is not independently reproduced in this audit | Phase 4.0.1 report records build, responsive, logic, hardening, and PostgreSQL results, including 389 passed / 1 skipped. This review used GitHub source access and did not execute the repository test suite. | Run install, typecheck, lint, unit, PostgreSQL integration, responsive, and build checks in a reproducible checkout before merge. Record exact commit and environment. |

## Current capability map

| Capability | Source-level status | Operational conclusion |
|---|---|---|
| Persistent agent memory and event ledger | Implemented; Phase 4.0.1 report records PostgreSQL integration | Repository-reported test evidence; production DB/deployment still needs verification |
| Deterministic policy and proposal lifecycle | Implemented in control plane | Proposal approval is not execution authorization |
| Global emergency stop | PostgreSQL-backed control row; Phase 4.0.1 report records integration checks | Keep fail-closed; restore permission is time-limited and currently lacks a separate role registry |
| Verified live market observations | Adapter gap documented | Not ready for live opportunity generation |
| Continuous worker/scheduler | Worker source exists | Production scheduler/supervision not established |
| Delegated signer and UserOperation dispatcher | Standalone implementation exists | Not integrated with `/agent`; no real UserOperation evidence |
| DCA autonomous execution | Explicitly blocked | Does not submit transactions |
| Live autonomous trading | Disabled by default / control-plane execution blocked | Not production-ready |

## Implementation sequence

### Phase A — establish one canonical contract
- Define the canonical strategy, market observation, proposal, approval, execution-intent, and execution-result types.
- Specify ownership, policy hash, quote freshness, amount denomination, chain, target token, nonce, and expiry invariants.
- Document which service owns each state transition. No service may infer approval from an AI recommendation or UI toggle.

### Phase B — close the market-data gap
- Implement a provider-backed observation/candle adapter with verifiable provider timestamps and provenance.
- Enforce bounded watchlists, rate limits, stale-data rejection, idempotency, and circuit breakers.
- Add deterministic fixture tests and separately gated real-provider contract tests.

### Phase C — connect durable orchestration to a supervised worker
- Deploy the worker outside request-scoped serverless functions.
- Add durable leases, heartbeat expiry, duplicate prevention, crash recovery, and dead-letter handling.
- Consume only persisted, unexpired, owner-approved intents whose policy hash still matches.
- Re-read emergency stop, policy, validator, balances, and route immediately before any dispatch attempt.

### Phase D — delegated authorization and testnet-only adapter
- Complete owner-controlled session grant/revoke/expiry and restart recovery.
- Keep signing authority scoped to one owner, chain, router, token, amount, and expiry.
- Add an explicit testnet-only feature gate that cannot be overridden by a UI field or model output.
- Verify failure behavior for stale quotes, RPC outage, bundler rejection, duplicate intent, nonce contention, revocation, expiry, and emergency stop.
- Do not enable mainnet as part of this phase.

### Phase E — security and release gate
- Independent review of contracts, signer custody boundaries, nonce logic, replay protection, spend caps, pause/revoke behavior, and dependency supply chain.
- Run full CI and PostgreSQL integration against a disposable database.
- Produce reproducible testnet evidence and an operator rollback/runbook.
- Mainnet requires a separate explicit decision and review; it is not an automatic follow-on.

## Verification limits

- This branch audit read repository files through the GitHub integration.
- No local checkout, package installation, build, lint, typecheck, or test execution was available during this pass.
- Repository test counts and verification claims above are attributed to the committed Phase 4.0.1 report, not represented as tests run by this audit.
- No files in this audit enable live execution or change signing/broadcast behavior.
