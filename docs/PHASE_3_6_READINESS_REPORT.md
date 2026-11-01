# Phase 3.6 Readiness Report

## 1. Executive summary

This repository already contains the Phase 3.5 execution-boundary hardening and fail-closed quote-only protections. The code currently rejects unsupported Binance SWAP/RFQ execution schemas, binds quotes to wallet and intent data, persists execution intent metadata in a durable PostgreSQL-backed store when configured, and prevents `FINISHED` from being treated as a verified fill without output evidence.

The overall status is:

B. REMEDIATION_IMPLEMENTED_NOT_LIVE_VERIFIED

This is not live execution approval. The controls are implemented and the available deterministic tests pass, but the required provider compatibility evidence and database-backed integration verification remain incomplete or blocked by external dependencies.

Key blockers:
- No live BAW operator wallet or BAW quote retrieval was verified in this environment.
- No PostgreSQL connection string was configured for the persistent store (`WOLV_TRADING_DATABASE_URL` and `BAW_EXECUTION_DATABASE_URL` were unset in this environment).
- The repo contains fail-closed rejection paths for unsupported Binance SWAP/RFQ schemas, but there is no authoritative fixture-backed provider contract proving the live Binance order and RFQ schema is compatible.
- `BAW_EXECUTION_ENABLED` remains disabled by configuration, and the execution/service config is intentionally fail-closed.

## 2. Files inspected and changed

Inspected:
- `services/bawExecution.ts`
- `services/bawExecutionStore.ts`
- `services/bawCli.ts`
- `services/bawQuote.ts`
- `services/bawQuoteHttp.ts`
- `services/browserTradeIntentStore.ts`
- `services/browserTradeExecutionBoundary.ts`
- `services/browserTradeBinding.ts`
- `app/api/agent/quote/route.ts`
- `app/api/swap/route.ts`
- `app/api/order/submit/route.ts`
- `app/api/transaction/broadcast/route.ts`
- `scripts/baw-execution.test.mjs`
- `scripts/browser-trading-hardening.test.mjs`
- `scripts/responsive-smoke.mjs`
- `.env.example`
- `TRADING_ARCHITECTURE.md`
- `package.json`

Created for this verification report:
- `docs/PHASE_3_6_READINESS_REPORT.md`

No feature-development changes were introduced here. This was a verification-only pass.

## 3. Previous Phase 3.5 findings and current status

| Finding | Status |
|---|---|
| SWAP transaction-intent validation | PARTIALLY_FIXED |
| RFQ typed-data validation | PARTIALLY_FIXED |
| Quote replay and duplicate prevention | PARTIALLY_FIXED |
| Persistent execution intent and concurrent submission protection | PARTIALLY_FIXED |
| RFQ retry/recovery | PARTIALLY_FIXED |
| SWAP receipt and output verification | PARTIALLY_FIXED |
| BAW `FINISHED` vs `FILLED` handling | FIXED_AND_TESTED |

Evidence:
- `services/browserTradeExecutionBoundary.ts` enforces store-backed intent mismatches and fail-closed rejection for unsupported SWAP/RFQ schemas.
- `services/browserTradeIntentStore.ts` stores quote-binding hashes, idempotency keys, execution states, and enforces transitions.
- `services/bawExecution.ts` includes `compareBawOutputQuantity()` and rejects provider `FINISHED` without output evidence.
- `services/bawCli.ts` validates CLI arguments and rejects unsupported market-order paths.
- The repo still does not have verified live-provider schemas for Binance SWAP or RFQ, so all execution routes are remain blocked unless provider semantics are verified and configured.

## 4. BAW decimal investigation and conclusion

The prior concern was the pattern:

`parseUnits(order.toTokenActualQty, 18)`

This is unsafe unless the provider guarantees 18-decimal output values for every token. The repository’s current code does not assume a universal 18-decimal model.

Evidence from code:
- `compareBawOutputQuantity()` in `services/bawExecution.ts` checks `tokenDecimals` and immediately returns `FINISHED_UNVERIFIED` when decimals are missing or invalid.
- `normalizeDecimalString(value, decimals)` requires the token decimal metadata to be present and within range, and rejects quantities with more fractional precision than the known token supports.
- `BawQuote` validation uses `asset.decimals` and rejects tokens whose decimal precision cannot be established.
- `parsePositiveAmount(value, decimals)` and `parseBalanceAmount(value, decimals)` use explicit decimal values, not a hardcoded 18.

Conclusion:
- `toTokenActualQty` is treated as token-native output quantity, not a hardcoded 18-decimal string.
- The code requires authoritative token decimal metadata before comparing outputs.
- The implementation is fail-closed when decimals are unknown or a value is malformed.
- This is the correct pattern for a provider contract that is not proven to be uniform across tokens.

Status: FIXED_AND_TESTED for the guardrail pattern, but not live-provider-verified for real BAW output semantics.

## 5. PostgreSQL integration results

Current state:
- `services/browserTradeIntentStore.ts` and `services/bawExecutionStore.ts` both instantiate PostgreSQL clients using environment-provided URLs.
- The repo requires `WOLV_TRADING_DATABASE_URL` and `BAW_EXECUTION_DATABASE_URL` for durable store behavior.
- In this environment, both variables were unset.

Evidence:
- `printf` output from the environment check showed both variables empty.
- `package.json` contains no dedicated PostgreSQL integration script.
- `.env.example` documents the server-only database URLs but leaves them blank and defaults execution to disabled.

Result:
- PostgreSQL integration tests are BLOCKED_EXTERNAL_DEPENDENCY.
- Database-backed guarantees cannot be claimed because the persistent database is not configured here.

## 6. Responsive test results

Executed command:
- `npm run test:responsive`

Runtime status:
- The app was started with `npm run dev` before the responsive suite was run.
- The suite did not complete successfully in this environment.

Observed result:
- First run: `ERR_CONNECTION_REFUSED` against `http://127.0.0.1:3000` before the app could be reached.
- Second run: DevTools navigation timed out while the script attempted to navigate the running page.
- The repository script therefore did not obtain a definitive pass/fail result for the responsive checks in this environment.

Status:
- `BLOCKED_IN_ENVIRONMENT` / `NOT_COMPLETED`.
- This is not a pass claim.

## 7. Binance SWAP compatibility evidence

The repository does not contain a verified provider contract for a live Binance SWAP response. The app therefore keeps the relevant route fail-closed.

Evidence:
- `app/api/swap/route.ts` rejects unsupported execution with `501` and an explicit “schema not documented or fixture-verified” response.
- `services/browserTradeExecutionBoundary.ts` rejects unsupported SWAP execution and store mismatches before any wallet submission path is reached.
- `TRADING_ARCHITECTURE.md` explicitly states that raw SWAP execution remains disabled pending verified provider semantics.

Status: BLOCKED_EXTERNAL_DEPENDENCY / PARTIALLY_FIXED

Rationale:
- The code blocks unsupported execution paths and validates intent binding, but there is no live or fixture-backed provider schema proving that all required fields are known and authoritative.

## 8. Binance RFQ compatibility evidence

The repo does not include authoritative live RFQ typed-data documentation or a fixture-verified contract that proves the exact EIP-712 structure, verifying contract, or signer semantics. As a result, RFQ signing/submission is blocked.

Evidence:
- `app/api/order/submit/route.ts` explicitly returns `501` for unsupported RFQ schema and rejects malformed or unverified payloads.
- `services/browserTradeExecutionBoundary.ts` blocks RFQ execution until the supported vendor/typed-data path is validated.

Status: BLOCKED_EXTERNAL_DEPENDENCY / PARTIALLY_FIXED

## 9. BAW provider compatibility evidence

BAW support is implemented in a controlled, fail-closed way. The code validates connected wallet state, chain, token, and quote integrity, and rejects execution if the provider output is malformed or inconsistent.

Evidence:
- `services/bawQuote.ts` rejects disconnected wallets and invalid or unsupported tokens.
- `services/bawCli.ts` validates `market-order quote` arguments and rejects unsupported or malformed inputs.
- `services/bawExecution.ts` checks `tokenDecimals`, recorded minimum output, and `FINISHED_UNVERIFIED` conditions.
- `services/bawExecutionStore.ts` enforces execution-state transitions and prevents unsafe fallback to in-memory execution when persistent storage is absent.

However:
- No live BAW quote retrieval was verified in this environment.
- The BAW operator wallet is not configured here, and execution remains disabled by configuration.

Status: PARTIALLY_FIXED

## 10. Regression test results

Executed commands and outcomes:
- `npm run test:logic` → PASS
- `npm run test:hardening` → PASS
- `npm run test:responsive` → NOT COMPLETED; the script failed with `ERR_CONNECTION_REFUSED` and then a DevTools timeout while navigating the app
- `npx tsc --noEmit` → PASS
- `npx eslint .` → PASS with warnings only (0 errors, 6 warnings)
- `npm run build` → PASS

Not executed / blocked:
- PostgreSQL integration tests → BLOCKED (no database URLs configured; no dedicated DB integration script in `package.json`)

Not verified:
- Live BAW quote retrieval
- Live Binance SWAP/RFQ compatibility
- Live execution or signing

## 11. Remaining unresolved issues

1. Provider compatibility is not proven for live Binance SWAP/RFQ payloads.
2. No live BAW quote retrieval or operator wallet validation was completed here.
3. Durable PostgreSQL verification remains blocked by missing configuration.
4. The repo protects the execution boundary but does not claim live trading compatibility.
5. Execution remains intentionally disabled in configuration and by fail-closed code paths.

## 12. External dependencies and missing documentation

Required external dependencies not satisfied here:
- PostgreSQL-compatible storage for `WOLV_TRADING_DATABASE_URL` and `BAW_EXECUTION_DATABASE_URL`
- BAW CLI/operator-wallet setup and authorization
- Provider-contract verification for Binance SWAP/RFQ payloads
- Live wallet session that is connected, authenticated, and preflight-checked

Documentation gaps:
- No dedicated `docs/PHASE_3_6_READINESS_REPORT.md` existed before this report.
- No script or harness in `package.json` specifically verifies PostgreSQL-backed execution state transitions.

## 13. Exact environment requirements

Required server-side values:
- `BAW_BIN`
- `BAW_WALLET_API_TOKEN`
- `BAW_AUTHORIZED_BROWSER_WALLETS`
- `BAW_EXECUTION_DATABASE_URL`
- `BAW_EXECUTION_ENABLED=true`
- `BAW_EXECUTION_KILL_SWITCH=false`
- `BAW_EXECUTION_MAX_ORDER_USDT`
- `BAW_EXECUTION_DAILY_LIMIT_USDT`
- `BAW_EXECUTION_MAX_SLIPPAGE_BPS`
- `BAW_EXECUTION_MIN_BNB_RESERVE`
- `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` if live Binance integration is ever enabled

Additionally, the execution host must be a persistent environment, not Vercel serverless; the code explicitly rejects serverless execution in `services/bawExecution.ts`.

## 14. Recommended next phase

The next phase should not be live execution. It should be a narrow verification pass that:
- provisions disposable PostgreSQL and runs the database tests,
- verifies provider fixtures against documented Binance/BAW schemas, and
- only then decides whether any execution path can be enabled.

If provider contracts remain undocumented, continue to keep execution disabled and maintain fail-closed behavior.

## 15. Final decision

B. REMEDIATION_IMPLEMENTED_NOT_LIVE_VERIFIED

This status fits the evidence in the code and available tests: the defensive controls are implemented and deterministic checks pass, but live provider compatibility and database-backed execution assurance remain unverified or externally blocked.
