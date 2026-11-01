# WOLV Phase 3.12 — Asset Metadata Report

**Final decision: A. `ASSET_METADATA_BLOCKER_UNRESOLVED`**

## 1. Executive summary

The production BAW asset resolver still has no authoritative source for token decimals. The RWA catalogue response validator does not define or validate a decimals field, and the parser deliberately maps only known fields. The resolver therefore returns an asset without decimals; `getBawQuote` rejects it before BAW quote command construction.

No undocumented catalogue field was promoted to trusted metadata and no decimal default was added. The quote service now validates supplied decimals and rejects sell quantities that exceed token precision without rounding. Mocked tests show that valid, explicitly injected metadata can pass BUY and SELL quote preparation and reach a command spy. This is preparation evidence only: the production resolver remains blocked, and no BAW command or provider request was run.

## 2. Original metadata-loss defect

The pipeline is:

1. `getRWATokenList` retrieves the RWA catalogue in [lib/binance.ts](../lib/binance.ts).
2. `isRwaAssetListResponse` checks required identity fields in [lib/rwaAssetResponse.ts](../lib/rwaAssetResponse.ts).
3. `parseRwaAssetRecords` reconstructs records from known catalogue fields in [lib/spotAssets.ts](../lib/spotAssets.ts).
4. `resolveBawSpotAsset` finds the uniquely matching record in [services/bawAsset.ts](../services/bawAsset.ts).
5. `getBawQuote` requires valid decimal metadata before preparing the quote in [services/bawQuote.ts](../services/bawQuote.ts).
6. Only after these checks does the service build validated quote arguments through [services/bawCli.ts](../services/bawCli.ts).

The response validator accepts catalogue records as generic records and does not specify decimals. The parser drops unrecognized fields, including any hypothetical `decimals` or `decimal` property. The resolver consequently returns no decimals, and quote preparation fails closed before reaching the CLI boundary.

## 3. Asset metadata source

No authoritative decimals source is established in the current production path:

- The RWA catalogue contract used by WOLV validates token address, ticker, and platform identity, but does not define decimal metadata.
- The BAW quote CLI documentation establishes a human-readable `--fromTokenQty` input convention; it does not establish an authoritative token-decimals metadata source.
- Decimal metadata described by the Binance Web3 aggregator schema belongs to that separate API contract. It has not been established as the RWA catalogue or BAW quote contract and is not substituted here.
- Names, symbols, addresses, chain IDs, and mocked fixtures are not evidence of token decimals.

**Result:** no authoritative upstream decimals field can currently be propagated. This report does not treat arbitrary extra catalogue fields as trusted metadata.

## 4. Before-and-after data flow

**Before:** the RWA resolver returned an asset without decimals; quote preparation rejected it before CLI argument construction.

**After this phase:** the resolver and catalogue schema remain unchanged because there is no authoritative source to propagate. Quote preparation validates a provided decimals value, uses it for SELL input-unit parsing, includes it in quote metadata, and rejects excess meaningful fractional precision rather than rounding. With the current production resolver, the missing-decimals rejection remains the expected result.

BUY input amount checks continue to use the service's existing 18-place numeric scaling for its established minimum-order guard. That value is not passed as raw token units to BAW and is not used as a fallback for selected-token decimals.

The local quote identity now includes the validated token-decimal metadata; the integrity verifier rejects a response whose decimal value was altered after quote creation.

## 5. Decimal validation rules

The quote service accepts decimals only as an integer from 0 through 255. Missing, `null`, negative, fractional, non-numeric, non-finite, or out-of-range values are rejected before the quote runner is called.

Amounts are normalized exactly, without rounding:

- SELL accepts no more non-zero fractional precision than the selected token's supplied decimals.
- Excess precision produces an `INVALID_REQUEST` rejection before CLI invocation.
- Redundant trailing zeroes are normalized without changing the amount.
- BUY/SELL request quantities remain positive human-readable strings; raw WOLV integer amounts are not sent as `--fromTokenQty`.
- Asset-address mismatch is rejected before the runner is called.
- Decimal metadata is covered by the quote identity and integrity binding.

## 6. BUY and SELL quote-path results

Tests inject decimal metadata directly into the quote service and use a mocked runner. They cover decimal counts 0, 6, 8, and 18 for both directions.

| Direction | Expected mapping | Mocked `--fromTokenQty` | Result |
|---|---|---:|---|
| BUY | BSC USDT → selected token | `100` | Correct human-readable amount, addresses, chain ID `56`, slippage, and quote-only argument list reached the spy. |
| SELL | selected token → BSC USDT | `1` | Correct human-readable amount, addresses, chain ID `56`, slippage, and quote-only argument list reached the spy. |

The representative argv shape asserted by the tests is:

```text
market-order quote --fromTokenQty 100 --fromToken <BSC-USDT-address> --toToken <selected-token-address> --binanceChainId 56 --slippage 1 --json
```

SELL asserts the reverse token pair and the supplied human-readable token quantity. The command spy verifies that neither direction produces a `market-order swap` command. The real BAW CLI was not invoked, and no provider was contacted.

## 7. CLI command-construction evidence

The tests prove only that valid injected metadata can reach the quote-only argument builder. They do not prove that the production resolver can supply such metadata, that the installed BAW CLI accepts the command, or that BAW returns a compatible response.

Missing or invalid metadata and excessive SELL precision are tested to prevent the runner from being called. BAW output quantity units, response slippage semantics, quote validity, and settlement remain unverified as described in the [Phase 3.11 provider evidence report](./PHASE_3_11_PROVIDER_EVIDENCE_REPORT.md).

## 8. Files changed

Phase 3.12 work:

- [services/bawQuote.ts](../services/bawQuote.ts) — decimal validation, quote metadata, exact amount-unit parsing, and explicit excess-precision rejection.
- [scripts/baw-quote.test.mjs](../scripts/baw-quote.test.mjs) — mocked BUY/SELL command-preparation, decimal-boundary, invalid-metadata, identity-mismatch, and exact-precision coverage.
- [docs/PHASE_3_12_ASSET_METADATA_REPORT.md](./PHASE_3_12_ASSET_METADATA_REPORT.md) — this report.

Inspected but not modified: [services/bawAsset.ts](../services/bawAsset.ts), [lib/spotAssets.ts](../lib/spotAssets.ts), [lib/rwaAssetResponse.ts](../lib/rwaAssetResponse.ts), and [services/bawCli.ts](../services/bawCli.ts).

## 9. Regression results

| Check | Result |
|---|---|
| Focused BAW quote tests | **44 passed**, 0 failed, 0 skipped. |
| `npm run test:logic` | **280 passed**, 0 failed, **1 skipped** (the PostgreSQL execution-record test is intentionally isolated to the PostgreSQL integration suite; that suite was blocked in this run). |
| `npm run test:hardening` | Passed. |
| `npm run test:responsive` | Passed across 320, 360, 390, 414, 768, 1024, and 1440 px; dynamic stock/trade routes and mocked refusal states passed. |
| `npm run test:postgres` | **Blocked**: `TEST_POSTGRES_URL` is not configured for a local disposable test database. No database was contacted. |
| `npx tsc --noEmit` | Passed. |
| `npm run lint` | Passed with 6 warnings and 0 errors. Warnings are in `components/TradeButton.tsx`, `lib/binanceExecutionValidation.ts`, `scripts/browser-trading-hardening.test.mjs`, `services/browserTradeIntentStore.ts`, and `services/browserTradeQuote.ts`; no warning was introduced in the BAW quote changes. |
| `npm run build` | Passed. |

## 10. Remaining BAW provider uncertainties

- The production decimals source needed by the asset resolver remains unavailable.
- BAW quote output amount units and token-native decimal handling are not authoritatively established.
- BAW response slippage scale, quote validity, and provider quote identity remain unresolved.
- BAW execution status and output fields do not independently establish recipient and settled output.

No live BAW quote was requested, and provider compatibility is not claimed.

## 11. Binance contract uncertainties

Phase 3.12 did not change the Phase 3.11 conclusions:

- Binance SWAP transaction response/calldata semantics are not sufficiently established to validate every execution-critical field.
- The complete Binance RFQ EIP-712 domain, typed-data schema, signing requirements, and submission lifecycle remain unresolved.

No code was changed to imply otherwise.

## 12. Current execution restrictions

No order submission, swap, transfer, signing, approval, transaction broadcast, contract deployment, autonomous execution, or production configuration change was made. Existing fail-closed execution boundaries and unresolved provider semantics remain unchanged. Mocked quote-path tests are not live-provider evidence.

## 13. Recommended next phase

Obtain an authoritative, versioned RWA/BAW-compatible decimals contract or official provider clarification. Only then should the metadata be added to response validation and propagated through the resolver, with conflicting or missing values still rejected. Separately, continue evidence acquisition for BAW output/settlement semantics and Binance SWAP/RFQ contracts before considering any compatibility or execution claim.
