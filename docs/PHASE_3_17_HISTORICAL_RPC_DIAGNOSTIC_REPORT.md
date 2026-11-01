# WOLV Phase 3.17 — Historical RPC Request Semantics

## Executive summary

**Decision: `HISTORICAL_RPC_FAILURE_UNRESOLVED`.**

Inspection of the installed viem implementation shows that `getBytecode` constructs `eth_getCode` with two parameters: `[address, block]`. A bigint block number is converted by `formatBlockParameter` to the canonical hexadecimal JSON-RPC quantity. The recorded block `131014770` therefore serializes as `0x7cf2072`. With no block number or tag, viem uses the `latest` tag.

The Phase 3.16 probe used the same bigint-based `getBytecode` path for its current and historical reads. Its current-state code reads succeeded while the historical reads returned provider error `-32000` with the sanitized message “Missing or invalid parameters. Double check you have provided the correct parameters.” This is evidence against an obvious difference in viem request construction, but the prior probe did not capture its actual wire body.

## Previous evidence

The Phase 3.16 artifact is [the saved archive probe](./audits/bsc-archive-probe-2026-11-01T09-19-42.969Z.json). It records:

- Chain ID `56`.
- Original block `131014770` and hash `0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e`.
- Latest block `131023849`, with latest-state bytecode reads succeeding for USDT and both approved catalogue tokens.
- Historical `eth_getCode` failures for all three addresses, each with error code `-32000` and the sanitized provider message above.
- No historical decimals calls and no configured archive endpoint.

The original 480-asset audit still records 100 successful bytecode/decimal reads followed by 380 `BYTECODE_READ_FAILED` entries, with USDT also failing. It has no request transcript. Those failures do not establish that the affected contracts lack code.

## Request construction findings

**Classification: `FIXED_AND_TESTED` for local request-shape evidence.**

The installed viem source was inspected directly:

1. `getCode` calls `formatBlockParameter`, then requests:
   `eth_getCode(address, block)`.
2. `formatBlockParameter` calls `numberToHex(blockNumber)` when `blockNumber` is a bigint.
3. If no bigint or block hash is supplied, the formatter returns the supplied tag or defaults to `latest`.
4. The standard viem HTTP transport serializes the method and parameters as a JSON-RPC body. The archive probe does not use a custom parameter-rewriting transport.
5. The Phase 3.16 current and historical code reads both pass a bigint `blockNumber`; their request shape differs only in the block quantity.

The Phase 3.17 test uses a real viem `createPublicClient` with a mocked `fetchFn`. It verifies:

| Caller input | JSON-RPC request |
|---|---|
| omitted `blockNumber` and `blockTag` | `eth_getCode(address, "latest")` |
| `blockNumber: 131014770n` | `eth_getCode(address, "0x7cf2072")` |

These are deterministic mocked requests, not a capture of the previous live request.

## Diagnostic changes

`lib/bscRpcWireRecorder.ts` now captures method, parameter count, sanitized target address, serialized block parameter type/value, caller block-input type when instrumented, attempt number, elapsed request duration, HTTP status, sanitized JSON-RPC error code/message, response validity, failure class, and retryability. It does not record request URLs or headers. Malformed successful HTTP responses are rejected by the recorder instead of being treated as valid RPC results.

`scripts/bsc-rpc-semantics-probe.mjs` provides a primary-only, fixed-target diagnostic. It reads the three addresses from the existing audit provenance and rejects a mismatch. Default operation is dry-run. Live operation requires `--live-read-only`, an interactive terminal, and the exact phrase:

`READ-ONLY RPC SEMANTICS PROBE`

The plan displays the redacted endpoint identity, chain, recorded block and hash, the three permitted addresses, and methods before confirmation. The live client sets viem `retryCount: 0`; the probe orchestration also sets `maxRetries: 0`. It has no archive endpoint, provider fallback, Binance/BAW integration, or write-capable operation.

## Tests and verification

The focused `scripts/bsc-metadata-audit.test.mjs` suite passed **46 tests**. Coverage includes actual viem wire serialization using mocked fetch, canonical block quantity, empty code, JSON-RPC error classification, malformed response rejection, timeout/abort classification, sanitized messages, strict block-input validation, dry-run planning, and confirmation gating. No automated test makes a live provider request. `pnpm exec tsc --noEmit`, targeted ESLint, and `git diff --check` passed after the final changes.

The existing Phase 3.15/3.16 tests in the focused suite additionally cover RPC failures, block provenance, and archive probe fail-closed behavior.

## Controlled live comparison

**Status: attempted but incomplete.** After the exact Phase 3.17 typed confirmation, the primary-only runner issued `eth_chainId` once. That request timed out at about 10 seconds. The returned probe artifact records:

- `eth_chainId`: `TRANSPORT_TIMEOUT`, attempt 1, duration `10042 ms`, no HTTP status or valid RPC response.
- No chain ID, block header, code, or decimals result was established.
- No requests for the three target addresses were made because the probe correctly stopped after chain verification failed.
- No retries or endpoint switch occurred.

The captured wire-record entry initially represented the abort's positive DOMException code (`20`) as a provider JSON-RPC error. This was a recorder/classifier defect, not an RPC response: the surrounding viem diagnostic identifies a `TimeoutError`, and no HTTP response or JSON-RPC body was received. The recorder now maps `AbortError` to `TRANSPORT_TIMEOUT`, excludes non-negative platform codes from provider error-code reporting, and records an omitted JSON-RPC `params` field as zero parameters. Deterministic regression tests cover this correction. The historical comparison itself remains unperformed.

If authorized, the runner will use only the configured primary endpoint and these addresses:

- USDT: `0x55d398326f99059fF775485246999027B3197955`
- Previously successful: `0xe614e2fc6c787035ff51f452e8e826bfd32d5283`
- Previously failed: `0x282973969118f9fe39bf2ff3d8dd1efee82ccb11`

If separately authorized for a fresh attempt, the runner will verify chain ID and both the latest and original block headers; read code at the captured latest block and the unchanged original block; and call `decimals()` only if valid non-empty code is established at the original block. It will not retry, switch endpoints, or read any other address.

## Remaining uncertainty and final decision

The local source and mocked transport establish the expected serialization path, but do not show the exact bytes sent during Phase 3.16 or explain why that provider accepted current-state code reads and rejected the historical quantity. The Phase 3.16 provider message is consistent with a parameter rejection but does not prove whether the cause was provider parsing, a provider restriction, or historical-state availability. The Phase 3.17 live attempt timed out at chain verification and provides no additional evidence about code-read request serialization or historical access.

**Final decision: `HISTORICAL_RPC_FAILURE_UNRESOLVED`.**

No finding in this report establishes archive capability or authorizes trading, BAW operations, wallet actions, or any transaction.
