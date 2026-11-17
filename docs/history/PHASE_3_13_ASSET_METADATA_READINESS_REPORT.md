# WOLV Phase 3.13 — Asset Metadata Readiness Report

**Date:** 2026-11-01  
**Final decision:** **B. ONCHAIN_DECIMAL_RESOLUTION_IMPLEMENTED_AND_TESTED**

## 1. Executive summary

The production BAW asset path now resolves token `decimals()` from read-only BSC contract calls for an asset selected from WOLV's existing RWA catalogue. It independently resolves the configured BSC USDT address, pins contract-code and metadata calls to one block, validates the decoded `uint8`, and fails closed on unsupported or unavailable data. BUY and SELL quote preparation now carries both tokens' metadata through to the mocked quote-command boundary.

The result is implemented and deterministically tested, but **not verified against live BSC contracts or the live asset catalogue**. No live RPC, catalogue, BAW CLI, quote, order, or transaction operation was performed. Decision C is therefore not supported.

## 2. BEP-20 metadata source

| Provider/source | Version/reference | Retrieved | Establishes | Does not establish |
|---|---|---|---|---|
| BNB Chain, [BEP-20: Tokens on BNB Smart Chain](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP20.md), section 5.1.1.3 | BEP repository `master`; no release version stated | 2026-11-01 | `decimals()` returns `uint8`; the value describes the divisor used to express a raw token amount in user representation. The text says this method is required for tokens that flow across BNB Beacon Chain and BNB Smart Chain. | That every deployed catalogue asset implements it, that a symbol/address alone implies a decimal value, or that a successful response establishes BAW quantity semantics. |
| Ethereum, [ERC-20](https://eips.ethereum.org/EIPS/eip-20), `decimals` method | Final ERC-20 standard | 2026-11-01 | ERC-20 defines `decimals() returns (uint8)` and marks it optional in ERC-20. | The implementation or value for any particular BSC contract. |
| BNB Chain, [JSON-RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/), BSC Mainnet | Documentation page; no version stated | 2026-11-01 | BSC mainnet is chain ID `0x38` / decimal `56`; lists `https://bsc-dataseed.bnbchain.org` as a mainnet endpoint. | That the runtime-configured endpoint is honest, available, or independently attested. |

These standards justify querying the actual contract method; they do not justify substituting a common decimal count when the method is unavailable.

## 3. Asset address provenance

The production resolver obtains records through WOLV's `getRWATokenList()` boundary, which uses Binance's RWA token-list route (`/api/v1/dex/market/rwa/tokens`) and validates the response shape. The existing catalogue fetch has a 60-second Next.js cache. The address must match exactly one parsed record and pass the existing spot-eligibility check before metadata resolution begins. Caller-provided arbitrary addresses do not reach the RPC resolver.

The catalogue itself was not fetched during this phase. Consequently, this report does not claim that any particular supported asset address, deployed contract, or decimal value was verified live.

## 4. On-chain resolution implementation

`services/bscTokenMetadata.ts` creates a read-only `viem` client for chain ID 56. It uses `NEXT_PUBLIC_BSC_RPC_URL` when configured and otherwise the BNB Chain endpoint listed above. For each selected asset, it:

1. Requires an internally selected eligible catalogue record and a valid EVM address.
2. Checks the RPC-reported chain ID is 56.
3. Obtains one block number.
4. Checks deployed bytecode at the selected token and configured BSC USDT address, pinned to that block.
5. Calls `decimals()` for both addresses at the same block.
6. Accepts only an integer `uint8` result in WOLV's supported range, then returns explicit provenance.

The result contains chain ID, checksum token address, decimals, `BSC_ETH_CALL` source, block number, resolution timestamp, and `VALIDATED` status. RPC, code, call, and decoding failures reject resolution; there is no decimal default or stale decimal-cache fallback.

The RPC endpoint is a trust dependency: checking chain ID, deployed code, and block-pinned calls does not independently prove that an RPC operator returned truthful data. A production RPC's trust and availability were not verified in this phase.

## 5. Decimal validation and supported range

- On-chain ABI: `decimals() returns (uint8)`.
- WOLV accepts **0 through 18 inclusive** because the current amount-normalization and arithmetic paths support at most 18 fractional places.
- Values 19 through 255 are rejected, even though they fit in `uint8`.
- Missing code, invalid address/checksum, wrong chain, reverted call, malformed return data, unsupported decimals, or conflicting pre-existing decimal metadata prevents quote preparation.
- Human-readable quantities with more fractional digits than the input token's decimals are rejected. They are never rounded.
- The raw on-chain `decimals` value is not replaced by a display multiplier, share ratio, reference price, or provider quantity convention.

## 6. Cache and proxy considerations

Decimal metadata is **not cached**. Each resolution queries current state and pins the code and `decimals()` calls for both tokens to the same block. A later request re-queries; if refresh fails, resolution fails rather than falling back to an older result. Therefore there is no decimal-cache TTL or expiration behavior to test.

The resolver calls the catalogue proxy address itself, allowing ordinary proxy dispatch to determine the value at the pinned block. Mock tests exercise this call path, but no live proxy was queried. The implementation does not identify a proxy implementation/admin, prove proxy immutability, or prevent a later implementation upgrade. Block number and timestamp are included in metadata and quote identity so a newly resolved result is distinct; they are provenance, not a guarantee of future immutability or block finality.

The existing RWA catalogue's 60-second cache is separate from decimal metadata. It affects which catalogue snapshot is used, not whether old decimal data is reused.

## 7. BUY and SELL metadata results

Quote preparation resolves selected-token and USDT metadata independently. The following values are **synthetic test values**, returned by mocked JSON-RPC/client responses; they are not live token metadata.

| Direction | Input token and tested decimals | Output token and tested decimals | Mocked quote-path result |
|---|---|---|---|
| BUY | Configured BSC USDT, 6 decimals | Selected catalogue token, 8 decimals | Correct addresses and decimals reach the quote-only argument builder. |
| SELL | Selected catalogue token, 8 decimals | Configured BSC USDT, 6 decimals | Correct addresses and decimals reach the quote-only argument builder. |

Separate resolver tests exercise 0-, 6-, 8-, and 18-decimal selected tokens, with USDT resolved independently. Quote/execution-preparation tests verify output-token decimals are retained for local minimum-output arithmetic. That local preparation does not establish the provider's output-unit contract or actual settlement semantics.

## 8. UI multiplier separation

No UI-multiplier interface is queried, and no UI multiplier is used to alter raw token quantities or BAW amounts.

| Provider/source | Version/reference | Retrieved | Establishes | Does not establish |
|---|---|---|---|---|
| BNB Chain, [BEP-677: Implement EIP-8056 Scaled UI Amount](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-677.md) | Draft, created 2026-04-14 | 2026-11-01 | The proposed extension describes a UI multiplier separate from raw token accounting and requires ERC-165 interface detection for compliant implementations; optional conversion extensions have separate interface IDs. | That any WOLV catalogue asset implements the draft or that BAW expects UI-scaled amounts. |
| Ethereum, [ERC-8056: Scaled UI Amount Extension for ERC-20 Tokens](https://eips.ethereum.org/EIPS/eip-8056) | Draft | 2026-11-01 | The draft specifies a UI multiplier interface and ERC-165 detection; it treats conversion helpers and UI-adjusted balances as extensions. | That the draft is finalized, universally supported, or applicable to any particular token without interface detection. |

`decimals`, `tokenToShareRatio`, `referencePrice`, and any potential UI multiplier remain distinct. The resolver does not probe interface IDs or call multiplier methods.

## 9. Quote integrity binding

Both validated metadata objects—including their addresses, decimal values, block numbers, source, timestamps, and validation status—are included in the local quote identity hash. The existing HMAC quote binding then binds that quote identity to the wallet, token pair, direction, chain, amount, and slippage, with the existing expiry checks. Tampering with or changing metadata invalidates the previously issued quote response.

This is WOLV quote-integrity protection only. It is not a provider-issued quote identity, transaction authorization, approval, or permission to execute.

## 10. Files changed for Phase 3.13

- `services/bscTokenMetadata.ts` — read-only BSC metadata resolution and provenance.
- `services/bawAsset.ts` — catalogue-gated asset resolution and metadata propagation.
- `services/bawQuote.ts` — per-token decimal validation, quote identity, and amount precision.
- `services/bawExecution.ts` — use verified input/output metadata in existing execution preparation and balance calculations.
- `services/bawExecutionStore.ts` — persist both input and output decimal values with the existing record.
- `lib/rwaAssetResponse.ts` — host the pure RWA record parser so the production resolver can be tested without loading Next.js cache infrastructure.
- `lib/spotAssets.ts` — preserve its existing parser export through the response module.
- `scripts/bsc-token-metadata.test.mjs` — mocked RPC, validation, block pinning, proxy path, and no-cache cases.
- `scripts/baw-quote.test.mjs` — catalogue-to-quote integration, BUY/SELL mapping, and quote-path validation.
- `scripts/baw-execution.test.mjs` — output-decimal preparation regression.
- `scripts/agent-quote-route.test.mjs` — metadata-bearing quote response fixtures.
- `scripts/responsive-smoke.mjs` and `scripts/postgres-integration.test.mjs` — existing regression fixture updates used by the full suite.

No production configuration, wallet authorization, transaction submission behavior, Binance SWAP route, or RFQ route was enabled.

## 11. Regression test results

All checks below were run after the Phase 3.13 code changes:

| Check | Result |
|---|---|
| Focused BSC metadata and BAW quote tests | 78 passed, 0 failed, 0 skipped |
| `npm run test:logic` with disposable `BAW_TEST_DATABASE_URL` | 316 passed, 0 failed, 0 skipped |
| `npm run test:postgres` against disposable PostgreSQL 16 | 4 passed, 0 failed, 0 skipped |
| `npm run test:hardening` | Passed |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | 0 errors; 6 warnings |
| `npm run test:responsive` | Passed at 320, 360, 390, 414, 768, 1024, and 1440 px; quote-only refusal flows passed |
| `npm run build` | Passed; production compilation and TypeScript checks succeeded |

The six lint warnings are existing unused-variable warnings in `components/TradeButton.tsx`, `lib/binanceExecutionValidation.ts`, `scripts/browser-trading-hardening.test.mjs`, `services/browserTradeIntentStore.ts`, and `services/browserTradeQuote.ts`. The production build completed without the earlier viem chain-registry bundling warning. It noted `NEXT_PUBLIC_WALLET_PROJECT_ID` is unset; injected wallets remain available.

All metadata and quote fixtures were mocked. The tests did not invoke the real BAW CLI or contact a provider.

## 12. Live RPC evidence

**None.** No BSC RPC request, catalogue fetch, or on-chain contract verification was performed. There are no live addresses, block numbers, RPC provenance records, or live-decimal results to report. Mocked RPC responses are test fixtures only and are not evidence that any supported production asset implements `decimals()`.

## 13. Remaining BAW provider uncertainties

No BAW CLI invocation or live quote was made. Existing unresolved questions remain:

- Whether BAW quote output quantities use human-readable values, raw token units, or another convention.
- Whether quote output and execution output share the same quantity convention.
- Whether BAW's returned slippage value has the scale WOLV currently expects.
- Whether returned output amounts are estimates or guaranteed minimums.
- How BAW quote validity, identity, recipient, and wallet binding are defined.
- What `FINISHED` guarantees about transaction confirmation, recipient, and independently verified settlement.

On-chain decimals resolve a token's own raw-unit precision; they do not resolve these BAW contract semantics.

## 14. Remaining Binance SWAP/RFQ uncertainties

The Phase 3.11 conclusions are unchanged. Binance SWAP transaction calldata semantics, recipient/output binding, and the relationship between the response envelope and executable payload remain insufficiently established. The complete RFQ EIP-712 domain, primary type, field schema, signature binding, and submission/status contract also remain unresolved. Existing routes remain fail-closed.

## 15. Current execution restrictions

No BAW CLI, BAW quote, live provider request, wallet signature, token approval, order, transaction broadcast, or contract deployment was performed. No production execution configuration was changed. The new resolver is read-only and catalogue-gated; the metadata and quote-path tests use mocks. Nothing in this phase authorizes live trading or execution.

## 16. External dependencies and recommended next phase

External dependencies are the Binance RWA catalogue's address/eligibility data, the configured BSC RPC's integrity and availability, and each eligible token's callable `decimals()` implementation at the queried block. Proxy upgrades and RPC honesty remain external trust considerations.

Next, if separately authorized, verify the live catalogue's supported address set using read-only BSC calls only. Record each address, chain ID, block number, RPC source, code-presence result, decoded decimal value, and any conflicts. Do not query arbitrary addresses. BAW output/settlement semantics and Binance SWAP/RFQ contracts require separate authoritative evidence; successful metadata reads or mocked quote preparation do not resolve them.

## 17. Final decision

**B. ONCHAIN_DECIMAL_RESOLUTION_IMPLEMENTED_AND_TESTED**

The resolver and metadata propagation are implemented and covered by deterministic mocked tests. Decision C is not justified because no actual read-only on-chain verification was performed for any supported asset, and live BAW provider compatibility remains unproven.
