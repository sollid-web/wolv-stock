# Phase 3.16 — Archive RPC Verification and Historical-State Diagnosis

**Report prepared:** 2026-11-01  
**Evidence status:** `LIVE_VERIFIED_SINGLE_RPC` for current code reads; `UNVERIFIED` for historical contract state and archive endpoint  
**Decision:** `ARCHIVE_STATE_ACCESS_NOT_ESTABLISHED`  
**Live requests in Phase 3.16:** Primary-only comparison performed after exact typed confirmation; no archive endpoint was configured.

## Executive summary

The Phase 3.15 recorded-block probe artifact shows the public BSC RPC returned chain ID 56 and the original block hash for block `131014770`. Its `eth_getCode` calls for USDT, the previously successful asset, and the previously failed asset all failed with JSON-RPC code `-32000`, then classified as `RPC_HISTORICAL_STATE_UNAVAILABLE`. That artifact did not preserve the provider's error message.

The Phase 3.16 confirmed primary-only probe found valid code for all three addresses at the endpoint's pinned latest block, `131023849`, while each historical `eth_getCode` request returned `-32000` with the sanitized provider message “Missing or invalid parameters. Double check you have provided the correct parameters.” Correct classification is `RPC_INVALID_PARAMETERS`, not proof of historical-state pruning. The recorded block header still matched the original hash.

An opt-in `BSC_RPC_ARCHIVE_URL` and an explicitly confirmed diagnostic runner now compare current and historical state for only the three fixed targets. The runner verifies the original block hash before historical contract reads, reads `decimals()` only after valid non-empty bytecode, and never switches endpoints automatically. The dry-run plan showed no archive URL configured, so no archive call or full catalogue audit was made.

## Previous audit and probe evidence

Sources: [Phase 3.14 audit](./audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json) and [Phase 3.15 recorded-block probe](./audits/bsc-metadata-probe-2026-11-01T08-50-42.358Z.json).
The Phase 3.16 primary-only result is preserved in [the archive-state probe artifact](./audits/bsc-archive-probe-2026-11-01T09-19-42.969Z.json).

The original audit reported 480 eligible assets: 100 code/decimal successes followed by 380 `BYTECODE_READ_FAILED` entries, and a failed USDT code read. Every entry used block `131014770`, hash `0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e`. The old JSON contains no request transcript, so it cannot explain the contiguous failure tail on its own.

The later probe used one RPC identity, `https://bsc-dataseed.bnbchain.org/<redacted>`, and recorded:

| Probe target | Address | Chain/header | Historical `eth_getCode` | Decimal call |
|---|---|---|---|---|
| USDT | `0x55d398326f99059fF775485246999027B3197955` | Chain 56; expected block hash matched | `-32000`, `RPC_HISTORICAL_STATE_UNAVAILABLE` | Not made |
| Previously successful | `0xe614e2fc6c787035ff51f452e8e826bfd32d5283` | Chain 56; expected block hash matched | `-32000`, `RPC_HISTORICAL_STATE_UNAVAILABLE` | Not made |
| Previously failed | `0x282973969118f9fe39bf2ff3d8dd1efee82ccb11` | Chain 56; expected block hash matched | `-32000`, `RPC_HISTORICAL_STATE_UNAVAILABLE` | Not made |

This earlier probe was single-RPC historical-header evidence. It contains no current-state code check or second-provider result. Its error code alone did not prove a specific archive/pruning policy.

## Current versus historical state

**Status: current code `LIVE_VERIFIED_SINGLE_RPC`; historical contract state `UNVERIFIED`.**

The confirmed primary-only probe used `https://bsc-dataseed.bnbchain.org/<redacted>` and recorded latest block `131023849` with hash `0xe3bc2fb14253df2b1111dbb630027f74227a0a5fd625210e47a882983e50cea0`. The endpoint returned non-empty code for all three targets at that pinned latest block. At the original block, it returned the matching header hash but errored on every code read:

| Target | Current code at block 131023849 | Historical code at block 131014770 | Historical decimals |
|---|---|---|---|
| USDT (`0x55d398326f99059fF775485246999027B3197955`) | Non-empty; SHA-256 `db71d17506cc212f6f6239dc29dabbc26feb68280a3f06c73ab4912597a71214` | `-32000`, `RPC_INVALID_PARAMETERS` | Not called |
| Previously successful (`0xe614e2fc6c787035ff51f452e8e826bfd32d5283`) | Non-empty; SHA-256 `58fba43507c43232a29ce63a6a94360e781c78e349d34ed0109cf2925b1e99b5` | `-32000`, `RPC_INVALID_PARAMETERS` | Not called |
| Previously failed (`0x282973969118f9fe39bf2ff3d8dd1efee82ccb11`) | Non-empty; SHA-256 `6b88e42d3946430232b32d7e4bf1eddd40f014bd801f65987067b02da06a70f0` | `-32000`, `RPC_INVALID_PARAMETERS` | Not called |

For each historical failure, the provider message was: “Missing or invalid parameters. Double check you have provided the correct parameters.” It is preserved in the generated probe JSON after sanitization. The saved probe's initial label `RPC_HISTORICAL_STATE_UNAVAILABLE` was too broad because it was inferred from wrapped error text. Reassessment with the corrected classifier maps these messages to `RPC_INVALID_PARAMETERS`; the original artifact retains its initial label alongside the raw sanitized message. This does not establish that the endpoint lacks archive state.

The runner's primary endpoint procedure is:

1. Verify `eth_chainId` equals 56.
2. Read `eth_blockNumber` and retrieve that exact latest header.
3. Call `eth_getCode` for the three permitted addresses at that pinned latest block.
4. Verify the original header at block `131014770` matches the recorded hash.
5. Call `eth_getCode` for the same three addresses at the original block.
6. Only for valid non-empty historical code, call `decimals()` at the same block.

The current comparison does establish that this endpoint served code for the three targets at the captured latest block. Historical code retrieval remains unresolved: the observed provider error says invalid parameters, not explicitly unavailable state.

## Archive endpoint and cross-provider evidence

`BSC_RPC_ARCHIVE_URL` is an optional server-only setting. It is not a `NEXT_PUBLIC_` variable. The runner prints only a redacted endpoint identity; credentials, path tokens, and query parameters are not included in plans or reports. It verifies chain ID and the original block hash before reading the three historical code results; it reads `decimals()` only after valid non-empty bytecode.

`BSC_RPC_ARCHIVE_OPERATOR` and the existing `BSC_RPC_OPERATOR` are operator labels. Cross-provider classification requires different non-empty labels plus the explicit environment attestation `BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED=I_CONFIRM_SEPARATE_OPERATORS`. This is still an operator attestation, not independent verification of ownership; absent that attestation, results cannot be classified as cross-verified. Different URLs alone do not establish independently operated infrastructure. Each endpoint's identity and results are recorded separately; a block/hash mismatch prevents combining results.

**Archive endpoint result:** `UNVERIFIED` — the local dry-run plan showed `BSC_RPC_ARCHIVE_URL` was unset. No archive endpoint request was made.

## Actual RPC error classifications

The Phase 3.15 saved probe records `providerErrorCode: -32000` and classification `RPC_HISTORICAL_STATE_UNAVAILABLE` for each historical `eth_getCode` failure, without a provider message. The Phase 3.16 probe records the same code and the message “Missing or invalid parameters. Double check you have provided the correct parameters.” for all three targets. The corrected message-based classifier maps this to `RPC_INVALID_PARAMETERS`; the generated artifact still records the original broad classification. No `MISSING_CONTRACT_CODE` result was returned: a failed RPC request is not evidence of empty code.

The reliability classifier now distinguishes invalid parameters, header-not-found messages, historical-state messages, generic provider execution errors, other JSON-RPC errors, transport errors, timeouts, HTTP 429/5xx, and malformed responses. It uses the sanitized provider message, rather than broad wrapper/cause-chain text, for JSON-RPC semantics. A bounded sanitized provider message is retained when available; URL, bearer, key, token, secret, and authorization values are redacted. A successful `0x` response is separately classified as `MISSING_CONTRACT_CODE`.

## Probe request authorization and safety

Run the new script without arguments for its dry-run plan. It displays the BSC network and chain, redacted primary/archive identities, the recorded block and hash, the three exact addresses, planned read-only methods, and whether distinct operator labels are configured. Dry-run makes no RPC request.

Live mode requires `--live-read-only`, an interactive terminal, and the exact typed phrase:

`READ-ONLY ARCHIVE STATE PROBE`

For the primary endpoint, the runner will call `eth_chainId`, `eth_blockNumber`, and `eth_getBlockByNumber` for the latest header and recorded header; `eth_getCode` for the three addresses at each pinned block; and `eth_call` for `decimals()` only after valid non-empty code at the recorded block. For a configured archive endpoint, it will call `eth_chainId`, `eth_getBlockByNumber` for the recorded header, then `eth_getCode` and conditional `eth_call` for the same three addresses at that block. The archive call is explicit and separately reported; no failed primary read triggers fallback or endpoint switching.

No Binance catalogue, BAW CLI/provider, wallet, signature, approval, transaction, deployment, or broadcast operation is possible in this runner. Only three compiled-in, prior-audit targets are accepted. No full 480-asset audit is started.

## Tests

Deterministic mocked tests cover:

- Current code available while original-block code reads return historical-state errors.
- Successful historical archive reads and conditional decimals.
- Same-block provider agreement and code/decimal divergence.
- Original block-hash mismatch and no code reads after mismatch.
- Empty bytecode versus failed bytecode retrieval.
- Header-not-found, historical-state and generic provider error classes.
- Credential and provider-message redaction.
- Endpoint configuration and redacted dry-run output.
- Typed confirmation, non-interactive refusal, and absence of automatic fallback.

Result: **40/40 targeted tests passed** in `scripts/bsc-metadata-audit.test.mjs`; `npx tsc --noEmit`, focused ESLint, and `git diff --check` passed. These are mock results only (`MOCK_VERIFIED` behavior). They are not live endpoint evidence.

## Files changed

- `.env.example`
- `README.md`
- `docs/PHASE_3_15_RPC_RELIABILITY_REPORT.md`
- `docs/PHASE_3_16_ARCHIVE_RPC_REPORT.md`
- `lib/bscArchiveProbe.ts`
- `lib/bscRpcReliability.ts`
- `scripts/bsc-archive-probe.mjs`
- `scripts/bsc-metadata-audit.test.mjs`

## Remaining uncertainty and re-audit strategy

- Current-state code availability on the public endpoint: verified for the three sampled targets at block `131023849`; this does not verify their historical metadata.
- Historical code availability on the public endpoint: failed for the three targets in the prior probe; exact provider cause remains unresolved.
- Archive endpoint configuration and capability: `UNVERIFIED`.
- Decimal metadata at the original block: `UNVERIFIED`; no decimal call was made because historical bytecode reads failed.
- Independent provider ownership and cross-provider agreement: `UNVERIFIED`.
- The prior 100-success/380-failure cutoff is consistent with a provider/request-path failure, but the original JSON and three-target probe do not establish why it occurred.

First perform only the explicitly confirmed three-target comparison. If an archive endpoint returns the correct recorded block and valid code/decimals for all three targets, preserve that as bounded evidence. Require matching block hashes and independently operated endpoints before classifying evidence as cross-verified. Only after the probe succeeds should a separate operator confirmation be considered for a full archive-backed audit. Retain the original catalogue snapshot hash and block provenance; do not silently substitute a new block.

## Final decision

**A. `ARCHIVE_STATE_ACCESS_NOT_ESTABLISHED`**

The primary endpoint's latest-state code reads succeeded for all three targets, and the original block header matched. However, historical code reads failed with `RPC_INVALID_PARAMETERS`, no archive endpoint was configured, and no second provider verified historical metadata. The probe therefore does not establish archive state access or explain the original 100/380 failure distribution. This decision does not authorize trading or BAW execution.
