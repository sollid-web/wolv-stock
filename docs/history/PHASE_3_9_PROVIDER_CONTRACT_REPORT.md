# WOLV Phase 3.9 — Provider Contract Report

**Date:** 2026-10-31

**Decision:** **B. PARTIAL_PROVIDER_COMPATIBILITY_VERIFIED**

## 1. Executive summary

Official Binance-maintained documentation establishes useful parts of the Binance aggregator and RFQ contract, and the Binance RWA quote adapter had three evidence-backed defects: it accepted non-contract quote IDs, did not verify route identity, and calculated prices as if both tokens had 18 decimals. Those checks are now strict, and quote calculations use the provider-reported decimals.

The Binance SWAP transaction envelope is documented, but its fields are optional and the available documentation does not establish a complete, decodable EVM transaction contract. Equity/RWA assets are documented as RFQ-only. The RFQ envelope and order lifecycle are documented, but the actual EIP-712 domain and message fields are opaque. The BAW CLI quote command is documented, but output-unit, quote-expiry, and wallet-binding semantics are not fully specified. Consequently, no execution route was enabled.

No live quote, order, signature, submission, or transaction was used as provider evidence. The responsive smoke may render normal read-only market data, but its results are not treated as provider evidence. There are no genuine sanitized provider fixtures in the repository; local fixtures remain mocks.

## 2. Scope and evidence sources

Inspected:

- BAW: `services/bawCli.ts`, `services/bawQuote.ts`, `services/bawQuoteHttp.ts`, `services/bawExecution.ts`, `services/bawExecutionStore.ts`.
- Binance/browser: `lib/binance.ts`, `lib/binanceExecutionValidation.ts`, `lib/browserTradeBinding.ts`, `lib/swapOutcomeVerification.ts`, `services/browserTradeQuote.ts`, `services/browserTradeExecutionBoundary.ts`, `services/browserTradeIntentStore.ts`, and the quote, approval, swap, and RFQ API routes.
- Tests: BAW CLI/quote/execution tests, browser trading hardening tests, quote validation tests, and PostgreSQL integration tests.

Primary references:

- Binance Agentic Wallet `market-order` documentation, pinned to [`binance/binance-skills-hub` commit `96563daf`](https://github.com/binance/binance-skills-hub/blob/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet/references/market-order.md).
- Binance Web3 connector generated REST/model documentation, pinned to [`binance/binance-web3-connector-java` commit `b5cb3b7`](https://github.com/binance/binance-web3-connector-java/tree/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs).

The connector documentation is provider-maintained contract documentation, not a captured response. Its generated models mark many response fields optional. The BAW reference is an official CLI skill document, not a complete provider API schema.

Evidence classifications used:

1. **AUTHORITATIVE_DOCUMENTATION** — the pinned Binance-maintained sources above.
2. **GENUINE_SANITIZED_PROVIDER_FIXTURE** — none found.
3. **MOCKED_TEST_FIXTURE** — local deterministic fixtures; not provider evidence.
4. **UNVERIFIED_ASSUMPTION** — semantics not established by the available documentation.

## 3. BAW provider contract

### Documented quote command

The documented syntax is:

```text
baw market-order quote --fromTokenQty <fromTokenQty> --fromToken <fromToken> --toToken <toToken> --binanceChainId <binanceChainId> [--slippage <slippage>] --json
```

The [official `market-order.md` reference](https://github.com/binance/binance-skills-hub/blob/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet/references/market-order.md) defines `--fromTokenQty` as a human-readable amount, accepts BSC chain ID `56`, and defines `--slippage` as a percentage from 0 to 100 (or `auto`). Its example response contains `success`, `data.fromCoinSymbol`, `fromCoinAmount`, `toCoinSymbol`, `toCoinAmount`, and numeric `slippage`. The example's amounts look human-readable, but the document does not normatively define output amount units, token-decimal behavior, or output slippage units.

The WOLV BAW quote path constructs only the quote command, maps BUY as USDT → selected token and SELL as selected token → USDT, and passes a human-readable quantity. It requires a connected wallet snapshot and BSC address before requesting a quote. These wallet/session checks and the API bearer authorization are WOLV controls; the BAW quote response itself does not document wallet identity binding. The separate BAW execution service was not changed in this phase.

### Identity, expiry, quantity, and status

The documented quote shape has no provider quote ID, chain/address identity, or expiry field. WOLV's quote ID is therefore a local hash, and its quote binding and expiration are WOLV-generated integrity controls—not provider-issued quote identity or expiry.

The CLI order-list example includes `toTokenActualQty` as a decimal-looking quantity and describes `FINISHED` as successful execution. It also warns that the absence of `refund` does not prove a full fill. The documentation does not provide authoritative token-decimal semantics for actual output quantities or a complete interrupted-order reconciliation guarantee. WOLV correctly retains `FINISHED_UNVERIFIED` when actual output evidence or supported decimal metadata is missing, but that is not independent on-chain settlement verification.

| Finding | Status | Result |
|---|---|---|
| Quote command syntax, human-readable input, and input slippage percentage | VERIFIED | Matches the WOLV CLI argument builder. |
| Quote output units, output slippage units, and token-decimal semantics | PARTIALLY_VERIFIED | Examples are suggestive, but the provider reference does not define these semantics sufficiently. |
| Provider quote ID, expiry, and wallet binding | UNVERIFIED | No such fields/guarantees are documented in the quote response. |
| `FINISHED` and actual output interpretation | PARTIALLY_VERIFIED | Status is documented; output units and independent settlement verification remain incomplete. |

No BAW quote command was run for this audit.

## 4. Binance quote and SWAP contract

The connector's [aggregated-quote model](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/GetAggregatedQuoteResponseDataInner.md) documents:

- A per-route `quoteId` described as a UUID without dashes.
- `binanceChainId`.
- `fromTokenAmount` and `toTokenAmount` as smallest-unit integer strings.
- Nested `fromToken` and `toToken` metadata, including `tokenContractAddress` and `decimal` (documented as a string).
- `executionMode`; the documentation says equity/RWA tokens always return `RFQ`.

The route model does not document a quote-expiration field. A `quoteId` is passed to the `/swap` endpoint to select/lock the route, but this does not establish a provider expiry guarantee.

For generic `SWAP` mode, the documented [`tx` model](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/BuildSwapTransactionResponseDataTx.md) includes `from`, router `to`, ABI-encoded `data`, native `value` in wei, gas fields, `minReceiveAmount` in smallest token units, and `slippagePercent`. These fields are all optional in the generated model. The router result contains token and amount metadata and echoes the requested chain identifier. The docs do not establish a contract ABI/function selector, calldata argument semantics, an independently verifiable recipient, or a chain ID intrinsic to the transaction object. The [approval response model](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/GetErc20ApproveTransactionResponseDataInner.md) describes optional approve calldata, a configured spender/router address, and gas fields; it does not provide a complete signed transaction.

The WOLV route supports RWA assets, for which Binance documents RFQ mode, not generic SWAP. WOLV's SWAP validator remains a hard rejection, and the swap API route does not forward unsupported transactions to wallet submission.

| Finding | Status | Result |
|---|---|---|
| Aggregated quote fields and smallest-unit amount convention | VERIFIED | Provider-maintained model documentation defines the field meanings. |
| RWA execution mode | VERIFIED | Equity/RWA routes are documented as RFQ. |
| Generic SWAP transaction envelope | PARTIALLY_VERIFIED | Field meanings are documented, but fields are optional and transaction/calldata semantics are incomplete. |
| Approval response envelope | PARTIALLY_VERIFIED | Spender and approve calldata meanings are documented; no genuine provider fixture was found. |
| Live Binance response compatibility | UNVERIFIED | No dedicated provider-compatibility call or response capture was used for this audit. |

## 5. Binance RFQ contract

The [RFQ response model](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/BuildSwapTransactionResponseDataRfq.md) describes an envelope with vendor, `txType` (currently `EIP712`), `typedDataToSign` (hex or JSON-encoded string), signing scheme, and optional vendor-resolved approval data. It requires the signing wallet to match the `userWalletAddress` used for the quote.

The [submission request](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/SubmitRfqOrderRequest.md) specifies a UUID-v4 `requestId` with a 30-minute idempotency window, a 65-byte `userSignature`, a vendor matching the RFQ response, and `quoteId` sourced from `rfq.orderId`. The [submission response](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/SubmitRfqOrderResponseData.md) may contain order ID, initial status, and timestamp. The [status model](https://github.com/binance/binance-web3-connector-java/blob/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs/GetRfqOrderStatusResponseData.md) defines intermediate and terminal states; for `FILLED`, it documents a transaction hash and actual `fromAmount`/`toAmount` as smallest-unit integer strings.

The available docs do **not** expose the actual EIP-712 domain, chain ID, verifying contract, primary type, message field list, nonce/request identity inside the typed message, or its expiry semantics. The typed data is an opaque string in the connector schema. Submission idempotency is not a substitute for order expiry. A terminal status schema is not independent proof that WOLV can validate the signed order or settlement.

WOLV continues to reject all RFQ typed data and submission attempts. No signing or submission was attempted.

| Finding | Status | Result |
|---|---|---|
| RFQ envelope, signing-wallet association, submission fields, and status lifecycle | PARTIALLY_VERIFIED | Workflow is documented, with optional response fields. |
| EIP-712 domain/message and expiry contract | BLOCKED_EXTERNAL_DEPENDENCY | Required signing semantics are opaque in available documentation. |
| RFQ execution compatibility | UNVERIFIED | Route remains fail-closed; no genuine provider fixture or live response. |

## 6. Adapter assessment and verified corrections

### Fixed and tested

1. **Quote ID validation:** The browser quote adapter previously accepted any short alphanumeric/underscore/hyphen ID and fell back to `orderId`. The documented quote route ID is a dashless UUID. WOLV now requires exactly 32 hexadecimal characters from `quoteId`; the same predicate is applied when creating stored intents and at the execution boundary. An unsupported `orderId` fallback is removed.
2. **Route identity and mode:** The browser quote adapter previously did not validate the provider's chain, token pair, or execution mode. It now requires BSC `56`, the requested USDT → RWA token pair, and `RFQ`, consistent with the documented RWA contract.
3. **Amount units:** The shared quote validator previously divided both smallest-unit amounts by 10¹⁸. It now normalizes using validated `fromToken.decimal` and `toToken.decimal` metadata. Both the browser-trade quote path and opportunity-price quote path pass the provider decimals and reject missing/inconsistent metadata. Provider amounts at the browser adapter must be decimal integer strings within uint256.

These are code-level corrections tested against mocked, documentation-derived fixtures. They are not evidence of live provider compatibility.

### Existing controls retained

- Approval validation continues to decode ERC-20 `approve`, bind the spender to the quote, constrain it to the reviewed trusted-spender list, and require the exact amount (or a necessary zero-reset).
- Browser quote bindings remain HMAC-protected, wallet/parameter-bound, and time-limited.
- Receipt output checks remain separate from quote validation.
- `validateBinanceSwapResponse` and `validateBinanceRfqTypedData` continue to reject unsupported provider execution payloads. No browser-wallet, ZeroDev, or BAW execution architecture was enabled or relaxed.

## 7. Files inspected and changed

### Changed during Phase 3.9

- `lib/apiValidation.ts`
- `lib/quoteValidation.ts`
- `lib/quotes.ts`
- `services/browserTradeQuote.ts`
- `services/browserTradeIntentStore.ts`
- `services/browserTradeExecutionBoundary.ts`
- `scripts/quote-validation.test.mjs`
- `scripts/browser-trading-hardening.test.mjs`
- `scripts/postgres-integration.test.mjs`
- `docs/PHASE_3_9_PROVIDER_CONTRACT_REPORT.md`

Other files were already modified or untracked from earlier phases and were not reverted or otherwise changed as part of this phase.

## 8. Regression and validation results

| Command | Result |
|---|---|
| `npm run test:logic` | **PASS** — 261 passed, 0 failed, 1 skipped. The skip is `PostgreSQL execution records survive independent store instances`, gated on `BAW_TEST_DATABASE_URL`. |
| `npm run test:hardening` | **PASS** — smoke checks passed against `https://wolv-stock.vercel.app`; this is a remote smoke check, not local provider evidence. |
| `npm run test:responsive` | **PASS** — 42 route/viewport checks across 320, 360, 390, 414, 768, 1024, and 1440 px on six fixed routes. Dynamic stock/trade detail routes were skipped because `TEST_TOKEN_ADDRESS` was not set. This smoke test checks route text, overflow, and primary navigation; it does not validate interactive approval/confirmation dialogs or provider compatibility. |
| `npm run test:postgres` | **PASS** — 4/4 tests against a dedicated loopback-only, disposable PostgreSQL 16 container; the container was removed afterward. PostgreSQL emitted a benign “migration table already exists” notice because both stores initialize the shared test schema. |
| `npx tsc --noEmit` | **PASS** |
| `npm run lint` | **PASS with 6 warnings, 0 errors.** Warnings include unused `checkApproval`, intentionally unused validator parameters, an unused test callback, `timingSafeEqual`, and a caught error variable. |
| `npm run build` | **PASS** — production build completed. |

All quote and provider-response tests use `MOCKED_TEST_FIXTURE` data. They are not captured Binance or BAW responses. The responsive runner is a UI smoke test and is not provider evidence.

## 9. Remaining blockers and external dependencies

- BAW needs an authoritative contract for quote output units/decimals, output slippage units, quote identity/expiry, and wallet/session binding.
- BAW actual-output status semantics need authoritative quantity units and a documented independent reconciliation path after interruption.
- Binance RFQ needs a complete EIP-712 schema and expiry/nonce semantics before signing can be supported.
- Binance SWAP needs an authoritative EVM calldata/ABI and recipient contract, plus a transaction-level chain binding and a complete required-field contract.
- Genuine sanitized provider fixtures or a separately approved read-only compatibility capture are still absent.
- A live quote was not verified. No Binance or BAW transaction, signature, order, or submission was attempted.

## 10. Current restrictions and recommended next phase

Binance SWAP/RFQ execution remains fail-closed. This audit did not change BAW execution configuration or authorize any execution. No live order, wallet signature, transaction broadcast, contract deployment, production configuration change, or autonomous execution was performed.

Next, obtain the missing provider schemas or genuine sanitized fixtures from Binance/BAW maintainers. Reconcile those sources with strict offline parsers and regression tests while leaving all signing and submission routes disabled. Any live quote verification should be separately scoped and must not be presented as execution verification.

## 11. Final decision

**B. PARTIAL_PROVIDER_COMPATIBILITY_VERIFIED**

Documented quote/RFQ/SWAP envelope semantics and deterministic code-level checks are partially verified. BAW quantity semantics and Binance RFQ signing internals remain unresolved, and provider compatibility has not been live-verified. Binance SWAP/RFQ remains fail-closed; BAW execution configuration was not changed or live-verified.
