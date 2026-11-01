# Phase 3.15 — BSC RPC Reliability Report

**Report prepared:** 2026-11-01  
**Finding:** `UNRESOLVED`  
**Decision:** `RPC_FAILURE_CAUSE_UNRESOLVED`  
**Live diagnostic status:** `UNVERIFIED` — no diagnostic RPC request was made.

## 1. Executive summary

The prior audit JSON establishes a sequential success prefix followed by an uninterrupted failure tail: 100 of 480 eligible catalogue assets have code and decimal results, and the remaining 380 asset code reads are recorded as `BYTECODE_READ_FAILED`. The configured USDT code read has the same error. All 480 asset results carry BSC chain ID 56 and the same recorded block number and hash.

The prior artifact does not contain request timestamps, HTTP status, provider error codes, transport causes, retry history, or a request transcript. Consequently, it cannot distinguish a provider cutoff, historical-state limitation, transport failure, or other RPC failure from those old classifications. The old `BYTECODE_READ_FAILED` label did not establish that the affected contracts lacked code.

The audit implementation now preserves RPC failures as unverified, identifies successful empty bytecode separately, emits sanitized per-attempt diagnostics, and supports bounded retries and bounded concurrency. A three-address probe is prepared, restricted to the recorded block and addresses in the prior audit, and defaults to dry-run. It requires the exact typed phrase `READ-ONLY RECORDED-BLOCK PROBE` before any RPC call. It has not been run because explicit operator confirmation is required.

## 2. Previous audit statistics and failure distribution

Source: [previous audit JSON](./audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json).
Recorded audit timestamp: `2026-11-01T08:14:16.554Z`.

| Measure | Recorded evidence |
|---|---:|
| Eligible asset records | 480 |
| Duplicate eligible addresses | 0 |
| Successful code reads | 100 |
| Successful decimal reads | 100 |
| Rows previously labeled `UNSUPPORTED` | 380 |
| Asset errors labeled `BYTECODE_READ_FAILED` | 380 |
| Confirmed empty-code responses in the failure tail | 0 |
| Decimal conflicts | 0 |
| USDT code result | `null`, `BYTECODE_READ_FAILED` |
| Audit status | `UNVERIFIED` |

Asset indexes 0–99 have code and decimal results; indexes 100–479 have `BYTECODE_READ_FAILED`. USDT follows the asset records and has that same error classification. This is a contiguous tail, not an intermittent pattern. The old `UNSUPPORTED` statuses are not evidence that these 380 contracts were absent: the underlying code-read results were not established.

The catalogue snapshot hash recorded in the JSON is `a86193b47831e314315e430c05f954c2d9e6ba8fc62f0be2a16e71fcf6102c99`.

The first 100 assets were individually labeled `LIVE_VERIFIED_SINGLE_RPC` by the prior audit, and the 380 failures were labeled `UNSUPPORTED`; the overall result remained `UNVERIFIED`. The individual success labels describe the captured single-provider responses only and are not independent cross-verification.

The artifact records every asset's block number as `131014770` and block hash as `0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e`. It contains no per-request time, status, duration, attempt, cause, or transcript fields. Its asset order is consistent with the sequential audit implementation, but it does not independently timestamp or prove the outbound request schedule.

## 3. Root-cause investigation

**Classification: `UNRESOLVED`.**

The old implementation caught every `getBytecode()` exception and represented it as `BYTECODE_READ_FAILED`. That erased the distinction between transport errors, HTTP errors, JSON-RPC errors, unsupported historical state, and malformed responses. The artifact has no evidence to recover the original error category.

The first 100 successful reads followed by a contiguous failure tail, including USDT after the assets, is consistent with a request-path or provider-side cutoff. It is not proof of rate limiting or any specific provider policy. The recorded audit implementation schedules those reads sequentially with default concurrency one, so hundreds of simultaneous requests are not supported as an explanation. The precise root cause remains unknown until an explicitly authorized probe captures live diagnostics.

## 4. Recorded block evidence

The previous artifact records:

- Chain ID: `56`
- Block number: `131014770` (`0x7cf2072`)
- Block hash: `0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e`

These are records from the original audit, not a new verification of the endpoint's historical-state support. No live `eth_getBlockByNumber`, historical `eth_getCode`, or historical `eth_call` was issued during this phase. Whether the configured endpoint can serve the recorded block remains `UNVERIFIED`.

## 5. Controlled probe plan and status

**Status: `UNVERIFIED`; pending explicit operator confirmation.** The probe reads the local previous audit JSON and uses only its two recorded catalogue addresses and configured USDT:

1. USDT: `0x55d398326f99059fF775485246999027B3197955`
2. Previously successful catalogue token: `0xe614e2fc6c787035ff51f452e8e826bfd32d5283`
3. Previously failed catalogue token: `0x282973969118f9fe39bf2ff3d8dd1efee82ccb11`

The runner validates these addresses against the original JSON and rejects arbitrary caller-supplied addresses. For the configured primary RPC endpoint, after the exact typed confirmation, it will:

1. Call `eth_chainId` with no parameters and stop unless the result is 56.
2. Call `eth_getBlockByNumber("0x7cf2072", false)` and stop unless the returned hash matches the recorded block hash.
3. In the fixed order above, call `eth_getCode(address, "0x7cf2072")` for each target.
4. Only when a valid non-empty bytecode result is received, call `eth_call({"to": address, "data": "0x313ce567"}, "0x7cf2072")` for `decimals()`.
5. Retry only classified transient failures, at most twice after the initial attempt, with bounded backoff and the same provider and block.

The probe makes no Binance catalogue or BAW call. It has no wallet client and cannot sign, approve, submit, deploy, or broadcast. Dry-run is the default and makes no network request. The exact live-mode confirmation is `READ-ONLY RECORDED-BLOCK PROBE`. No live result is claimed here.

## 6. Error classification and reliability changes

`lib/bscRpcReliability.ts` classifies HTTP 429 and 5xx responses, other HTTP errors, timeouts, DNS failures, connection resets/refusals, JSON-RPC errors, historical-state errors, and invalid responses. Diagnostics include method, stage, class, sanitized provider code, HTTP status, attempt, duration, response validity, retryability, retry-after, success, and a bounded sanitized cause chain. Raw error messages and endpoint URLs are not emitted.

The audit and probe now distinguish a successful, valid empty `eth_getCode` result (`0x`, reported as `MISSING_CONTRACT_CODE`) from failed or malformed code requests (`UNVERIFIED`). A timeout or RPC failure cannot become a no-code result. Malformed results mark their diagnostic as invalid and are not retried.

Transient retries are capped at two, use exponential backoff with jitter, and honor a valid `Retry-After` within the configured maximum delay. Invalid parameters, malformed responses, and successful empty bytecode are not retried. Every retry retains the same block and RPC endpoint. Provider switching is not automatic.

The previous run used sequential requests; this did not establish a concurrency/rate-limit issue. The current audit defaults to concurrency one and accepts only explicitly selected concurrency from one through four. Results retain catalogue order. No concurrency increase is recommended before the controlled probe establishes that the failure is a throughput issue.

## 7. Secondary RPC availability

The runner supports optional `BSC_RPC_SECONDARY_URL` and `BSC_RPC_SECONDARY_OPERATOR` configuration. An operator label distinct from the primary label is required before the runner attempts cross-verification. Different endpoint URLs alone are not treated as proof of independence. Labels are configuration assertions and do not independently verify provider ownership.

No secondary RPC was used for this diagnosis. Availability and independent operation of any currently configured second endpoint were not verified. There is no independent block-hash, code, or decimal comparison. The previous run is single-RPC, and historical results remain unverified where the prior call failed.

## 8. Bounded re-audit strategy

No full 480-asset re-audit was started. First run the three-target probe only after typed operator confirmation. If it identifies a correctable scheduling or transient-failure issue, validate that correction against the same three targets and recorded block before preparing a bounded catalogue audit.

The previous result JSON contains asset rows and a catalogue snapshot hash, but not the complete sanitized normalized catalogue snapshot required to establish exact snapshot reuse. A later audit must either obtain and separately hash a fresh catalogue snapshot, or establish a reproducible snapshot source before claiming reuse. A full catalogue pass requires separate explicit confirmation and must retain the original block when the endpoint verifies it; it must not silently substitute a latest block.

## 9. Unsupported contracts, conflicts, and failed calls

The previous report classified 380 assets as `UNSUPPORTED`, but their underlying `eth_getCode` requests were recorded only as `BYTECODE_READ_FAILED`. None had a successful empty-code response, so none can be called confirmed no-code contracts from this evidence. USDT similarly has no confirmed bytecode result. The JSON reports no decimal conflicts. No new contract failure, block mismatch, RPC divergence, or metadata conflict was observed because no live calls were made.

Evidence statuses are used as follows: `LIVE_VERIFIED_SINGLE_RPC` for a successful live single-provider result; `LIVE_VERIFIED_CROSS_RPC` only for matching results at a matching block from independently operated providers; `MOCK_VERIFIED` for deterministic mocks; `UNSUPPORTED` only for confirmed unsupported contract/metadata conditions; `RPC_DIVERGENCE` for mismatching RPC evidence; and `UNVERIFIED` when a result cannot be established. This report has no new live verification.

## 10. Test results

The deterministic test file `scripts/bsc-metadata-audit.test.mjs` passes **34/34** tests. It uses mocked catalogue and RPC methods; no provider was contacted. Coverage includes:

- Previous audit statistics and contiguous failure distribution.
- Catalogue parser, eligibility, duplicate-address rejection, and fixed probe targets.
- Chain and block mismatch; same-block pinning; secondary-provider divergence.
- Empty bytecode versus failed code reads; valid and malformed decimal results; USDT failure and metadata conflict.
- HTTP 429/5xx, timeout, DNS, socket reset/refusal, JSON-RPC errors, historical-state failures, and error-code redaction.
- Retry bounds, `Retry-After`, concurrency limits, input ordering, and same-block behavior.
- Dry-run default, typed confirmation, arbitrary-address rejection, and absence of transaction-writing client methods.

Verification passed: the focused deterministic suite reports **34/34**; `npx tsc --noEmit` exits successfully; ESLint passes for the six Phase 3.15 implementation/test scripts and libraries; and `git diff --check` passes. The tests are `MOCK_VERIFIED` behavior only, not live verification.

## 11. Files changed for Phase 3.15

- `lib/bscMetadataAudit.ts`
- `lib/bscMetadataProbe.ts`
- `lib/bscRpcReliability.ts`
- `scripts/bsc-metadata-audit.mjs`
- `scripts/bsc-metadata-audit.test.mjs`
- `scripts/bsc-metadata-probe.mjs`
- `docs/PHASE_3_15_RPC_RELIABILITY_REPORT.md`

## 12. Remaining uncertainties

- **`UNRESOLVED`** — the original provider failure mechanism; the old artifact contains no request diagnostics.
- **`UNVERIFIED`** — current support for the recorded block, its historical bytecode, and `decimals()` calls.
- **`UNVERIFIED`** — current code and decimal metadata for the three diagnostic targets, all other eligible assets, and USDT.
- **`UNVERIFIED`** — existence and independent operation of a configured secondary RPC.
- Live diagnosis remains unperformed pending explicit operator confirmation; no current provider reachability or historical-state result is claimed.
- A successful decimal read would establish only the return value at that block. It would not prove token legitimacy, share denomination, UI multiplier support, BAW quantity semantics, or provider settlement.

## 13. Current execution restrictions

This phase is read-only. No BAW CLI or quote call, wallet signature, token approval, transaction, deployment, broadcast, production execution configuration change, or trading operation was performed or enabled. The probe's client surface contains only chain/block/code/contract-read methods. No default decimal is substituted and no failed read is labeled as an absent contract.

## 14. Final decision

**A. `RPC_FAILURE_CAUSE_UNRESOLVED`**

The evidence does not establish a provider failure mechanism, and no new live read was authorized or performed. The prior audit is single-RPC; there is no independent cross-verification. This decision does not authorize trading or BAW execution.

## Addendum — recorded-block probe result

The later [recorded-block probe artifact](./audits/bsc-metadata-probe-2026-11-01T08-50-42.358Z.json) records chain ID 56 and a matching hash for block `131014770`, followed by `eth_getCode` failures for USDT, the previously successful token, and the previously failed token. All three are classified `RPC_HISTORICAL_STATE_UNAVAILABLE` with provider error code `-32000`; no decimal calls were made. This establishes that this endpoint returned the header but failed these three historical code reads at that time. The artifact does not preserve the provider message or establish current-state availability, so the exact cause remains unresolved.
