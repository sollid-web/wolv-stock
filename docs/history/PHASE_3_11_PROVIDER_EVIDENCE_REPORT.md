# WOLV Phase 3.11 — Provider Evidence Report

**Date:** 2026-11-01  
**Final decision:** **B. PARTIAL_PROVIDER_SEMANTICS_ESTABLISHED**

## 1. Executive summary

Authoritative, version-pinned provider documentation establishes useful parts of the BAW CLI and Binance Web3 contracts, but not enough to claim end-to-end compatibility or enable execution.

The official BAW skill reference identifies `--fromTokenQty` as human-readable and documents example quote/order response shapes and the provider's three market-order statuses. It does not normatively define quote output decimal units, output slippage scale, token metadata provenance, quote expiry/identity, output recipient, or independent settlement proof. In the current WOLV integration, the asset resolver drops decimals and the BAW quote service rejects missing decimals before it reaches the CLI. This remains fail-closed.

The official Binance Web3 connector v4.4.1 models define quote amounts in smallest units and document much of the generic transaction envelope. Fields are optional; calldata function semantics, recipient binding, a transaction-level chain ID, and quote expiry are not fully established. The RFQ envelope/order lifecycle is documented, but the actual EIP-712 domain and complete typed-data schema are opaque. SWAP/RFQ payload validation remains rejection-only.

No genuine provider response, support clarification, or live read-only provider result was acquired. No provider operation was attempted. Mocks are classified only as test fixtures. No code was changed.

## 2. Evidence acquisition methodology

1. Inspected BAW CLI, quote, execution, persistence, asset-resolution, and provider-boundary code and their current tests.
2. Retrieved official Binance documentation from version-pinned GitHub commits:
   - Binance Agentic Wallet skill hub commit `96563daf34fa5a87af5d76c2f1107d697ae7ce07`; the commit's `binance-agentic-wallet v1.0.0` label is the skill-hub release, not a CLI version.
   - Binance Web3 connector Java commit `b5cb3b758d606d2a1ee024cfd8005f44f667d510`, release `web3-wallet v4.4.1`, dated 2026-09-29.
3. Recorded exact source, version, section, retrieval date, established meaning, and remaining gaps in the [provider evidence register](./PHASE_3_11_PROVIDER_EVIDENCE_REGISTER.md).
4. Did not call provider quote/order APIs or the BAW CLI. The user authorized evidence acquisition but made read-only provider requests conditional on endpoint documentation, explicit environment authorization, and certainty that no signing/submission/broadcast could occur. That authorization and operation-path safety were not independently established, so no request was made.
5. Did not inspect runtime secrets/configuration or production databases. No genuine response fixtures were created; therefore no fixture hash exists.

## 3. BAW quote contract

### Established by official CLI documentation

The [pinned `market-order.md`](https://github.com/binance/binance-skills-hub/blob/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet/references/market-order.md) states that:

- Quote syntax accepts `--fromTokenQty`, token addresses, chain ID, optional `--slippage`, and JSON output.
- `--fromTokenQty` is human-readable.
- Input `--slippage` is described as `auto` or a percentage from 0 to 100.
- The example quote has `success`, `data.fromCoinSymbol`, `fromCoinAmount`, `toCoinSymbol`, `toCoinAmount`, and numeric `slippage`; the amount values look decimal/human-readable.
- The quote is described as showing expected output before commitment.

The source does **not** normatively specify output quantity units, token decimals, output `slippage` scale, guaranteed output/minimum-output behavior, or a price field. It supplies no quote ID, expiry, recipient, or wallet-binding field in the documented quote response.

### Existing WOLV behavior and blocker

- WOLV constructs BUY as USDT → selected token and SELL as selected token → USDT; it validates a connected BAW snapshot/address and applies local reference, freshness, and market checks.
- WOLV computes price from the two amount strings and expects returned `slippage` to equal input percentage divided by 100. The docs do not define the response field's scale, so this is not provider-verified.
- `services/bawQuote.ts` requires token decimals. The production resolver (`services/bawAsset.ts` → `parseRwaAssetRecords`) does not populate them. Therefore, with the current real resolver, `getBawQuote` rejects the asset before requesting a CLI quote.
- WOLV creates its own quote hash, expiry, and integrity binding. Those are WOLV controls and are not BAW-issued quote identity, expiry, or wallet binding.

**BAW quote classification: PARTIALLY_VERIFIED.** Command input convention and an illustrative output shape are documented; actual provider response semantics and current runtime compatibility are not.

## 4. BAW quantity and settlement semantics

| Item | Provider documentation establishes | Still unresolved |
|---|---|---|
| `fromTokenQty` | Input is human-readable. | Exact precision rules by token/chain. |
| `fromCoinAmount`, `toCoinAmount` | String fields shown as decimal-looking examples; quote estimates expected output. | Normative output unit/decimals and guarantee semantics. |
| `toTokenActualQty` | Order-list example calls this the actual received amount; field is optional. | Unit/decimal convention, independent source, and recipient binding. |
| Minimum output | No explicit minimum output field in the documented quote response. | Whether the CLI/provider enforces an output minimum and how it relates to slippage. |
| Token decimals | No authoritative decimal source in the BAW quote reference. | How decimals should be obtained/authenticated for an RWA asset. |
| Quote price | No explicit price field. | Fee inclusion and provider price formula; WOLV locally derives a ratio. |
| Slippage | Input is percentage-formatted. | Output response value is numeric `0.005` in the example, but its units are unspecified. |
| Expiry/identity | No quote ID or expiry shown. | Validity duration and provider identity/binding. |
| `PENDING` | “Being processed on-chain.” | Exact chain lifecycle and all intermediate states. |
| `FINISHED` | “Executed successfully”; the guide says report `txHash` and actual received amount when available. | Confirmation depth/finality, output recipient, and independent verification guarantee. |
| `FAILED` | “Execution failed”; submission guidance notes `txHash` may be null. | Complete retry/reconciliation guarantee. |
| `CANCELLED` | Not included in the documented market-order status list (`PENDING`, `FINISHED`, `FAILED`). | Whether cancellation exists for market orders. |

`FINISHED` is documented as the provider's successful-execution status, but the docs do not establish that WOLV independently verified chain settlement or the actual recipient/output. The report therefore retains `FINISHED_UNVERIFIED`; it does not reinterpret or upgrade the provider status. The order guide also warns that missing `refund` data does not prove a full fill. Refund amounts are explicitly human-readable; the docs do not apply that explicit unit statement to `toTokenActualQty`.

**BAW output/settlement classification: PARTIALLY_VERIFIED.** Status labels and selected fields are documented, but reliable quantity units and independent settlement semantics are not.

## 5. Binance SWAP contract

The pinned [Web3 connector v4.4.1 models](https://github.com/binance/binance-web3-connector-java/tree/b5cb3b758d606d2a1ee024cfd8005f44f667d510/clients/web3-wallet/docs) establish:

- Quote amounts `fromTokenAmount` and `toTokenAmount` are smallest-unit integer strings; `toTokenAmount` is an estimate.
- Token metadata may provide address, decimal string, USD unit price, and token flags. These fields are optional.
- `executionMode` distinguishes `SWAP` and `RFQ`; documentation says equity/RWA assets always return `RFQ`.
- Generic SWAP `tx.from` is described as user sender; `tx.to` as DEX router; `tx.data` as ABI-encoded calldata; `tx.value` in wei (`"0"` for ERC-20); gas fields as estimates/fee values; `minReceiveAmount` as smallest-unit amount accepted at slippage; and `slippagePercent` as a percentage string. The fields are optional.
- Approval model `dexContractAddress` is described as the spender in the approve call, distinct from the transaction router `to`.
- Route/router result includes echoed chain ID; the documented EVM `tx` model does not itself specify chain ID.
- Route `quoteId` is a dashless UUID used to select/lock a route, but no expiry is documented.

The models do not provide the ABI/function-selector contract, decoded calldata arguments, transaction recipient binding, or proof that calldata enforces the returned route/minimum-output details. Provider fields are not a guarantee of safe transaction semantics. A non-empty calldata string, nonzero `minReceiveAmount`, or valid quote ID cannot establish transaction intent or acceptable price impact by itself.

**Existing WOLV validation:** unsupported SWAP payloads are rejected. The separate approval validator decodes standard ERC-20 `approve`, binds the spender to the quote and a reviewed trusted-spender list, and limits approval to an exact amount or permitted zero-reset. It does not validate the swap transaction's calldata or router semantics.

**SWAP classification: PARTIALLY_VERIFIED contract envelope; BLOCKED_EXTERNAL_DEPENDENCY for execution compatibility.** The documented fields are not a complete safe transaction contract. WOLV remains reject-only.

## 6. Binance RFQ contract

The pinned official RFQ models establish:

- RFQ response has optional `vendor`, `txType` (currently `EIP712`), opaque `typedDataToSign`, `signingScheme`, and optional vendor-resolved approval data.
- The signing wallet must match `userWalletAddress` used for quote.
- Submission `userSignature` is a `0x`-prefixed 65-byte signature; vendor must match the RFQ response.
- `quoteId` submitted is `rfq.orderId`.
- `requestId` is UUIDv4 and provides a 30-minute idempotency window. This is retry idempotency, not signed-order expiry.
- Submission response may provide a platform order ID and initial status.
- Status model describes `PENDING_VENDOR`, `PENDING_ONCHAIN`, and terminal `FILLED`, `FAILED`, `EXPIRED`, `CANCELLED`. For FILLED it documents a transaction hash and actual from/to quantities as smallest-unit integer strings.

The models do **not** establish the EIP-712 domain name/version, chain ID, verifying contract, primary type, complete ordered field definitions, signer/maker roles in the typed payload, signed input/output quantities, nonce, order expiry, recipient, or partial-fill semantics. `typedDataToSign` is opaque in the connector schema. The status model's optional fields do not by themselves prove WOLV can independently verify settlement.

**RFQ classification: PARTIALLY_VERIFIED envelope and lifecycle; BLOCKED_EXTERNAL_DEPENDENCY for signing/submission compatibility.** The existing WOLV RFQ boundary continues to reject all signing/submission payloads.

## 7. Evidence register summary

| Classification | Evidence acquired |
|---|---|
| AUTHORITATIVE_DOCUMENTATION | Official, commit-pinned Binance Agentic Wallet skill documentation. |
| OFFICIAL_SDK_SCHEMA | Binance-maintained Web3 connector Java v4.4.1 generated model documentation. |
| GENUINE_SANITIZED_PROVIDER_RESPONSE | None. |
| OFFICIAL_PROVIDER_CLARIFICATION | None. |
| MOCKED_TEST_FIXTURE | Existing WOLV BAW quote/order unit-test fixtures only; not provider evidence. |
| UNVERIFIED_ASSUMPTION | BAW quote output decimal/slippage scaling and any undocumented expiry, wallet-binding, or settlement guarantee. |

The complete field-by-field register, including exact URLs, relevant fields, retrieval dates, and uncertainty, is [PHASE_3_11_PROVIDER_EVIDENCE_REGISTER.md](./PHASE_3_11_PROVIDER_EVIDENCE_REGISTER.md).

## 8. Compatibility matrix

| Capability | Required contract evidence | Existing WOLV validation | Compatibility status |
|---|---|---|---|
| BAW quote | Actual response schema; input/output units; output slippage; decimals; expiry/identity | Strict exact-shape parsing, BUY/SELL and symbol/input matching, local binding/freshness/market checks; production asset resolver currently omits required decimals | **PARTIALLY_VERIFIED** |
| BAW output verification | Actual output units, recipient, and authoritative settlement semantics | Requires `FINISHED` status but stores `FINISHED_UNVERIFIED`; actual output is displayed, not treated as independently verified | **PARTIALLY_VERIFIED** |
| Binance SWAP | Complete transaction semantics, calldata/selector, recipient, chain, amounts, spender, expiry | All SWAP transaction payloads rejected; approval validator is separately strict and quote-bound | **BLOCKED_EXTERNAL_DEPENDENCY** |
| Binance RFQ | Complete EIP-712 domain/types/fields, signer and order semantics, expiry, submission/status | RFQ typed data and order submission remain rejected | **BLOCKED_EXTERNAL_DEPENDENCY** |

Rejecting unsupported data is a fail-closed control; it is not evidence of provider compatibility.

## 9. Code changes

**None.** This phase was documentation and evidence acquisition only. No change was justified by a provider contract that could be implemented without filling an evidence gap or making an assumption. No application behavior was altered.

## 10. Unresolved questions

1. What units/decimal convention does BAW use for `toCoinAmount` and `toTokenActualQty` across supported token types?
2. What scale and meaning does BAW use for the returned numeric `slippage`?
3. What authoritative BAW metadata source provides token decimals for supported RWA tokens?
4. Does BAW guarantee `FINISHED` means a sufficiently confirmed, settled transaction? Is the reported output quantity chain-derived, and how is recipient identity established?
5. What quote validity/expiry and identity binding, if any, does BAW enforce?
6. What ABI, function selector, calldata argument, recipient, and transaction chain-binding contract does Binance guarantee for each SWAP route/vendor?
7. What are the exact Binance RFQ EIP-712 domain, primary type, complete fields/types/order, nonce, expiry, maker/signer, and token/quantity semantics?
8. Does Binance support RFQ partial fills, and what status/data evidence records them?

## 11. External provider dependencies

- BAW needs an authoritative, versioned specification for quote response units/slippage, token decimals, quote lifetime, and the relationship between `FINISHED`, transaction confirmation, and actual output/recipient.
- Binance Web3 needs full SWAP ABI/transaction semantics for any supported route and complete RFQ typed-data/order-signing documentation.
- A genuine sanitized response can corroborate an official schema but cannot replace missing normative signing/security guarantees.
- Official written provider clarification may resolve questions absent from public docs. No clarification was requested or received in this phase.

## 12. Execution restrictions

- No BAW CLI or provider quote API was called.
- No live order, approval, RFQ signature, wallet signature, transaction broadcast, contract deployment, or transaction-status RPC was attempted.
- No secrets, production environment configuration, or production database were inspected or changed.
- No execution configuration was enabled or altered.
- Binance SWAP/RFQ payload validation remains rejection-only. BAW output remains `FINISHED_UNVERIFIED` where settlement evidence is insufficient.

## 13. Recommended next step

Keep all execution routes fail-closed. Obtain official BAW answers for output units, decimal metadata source, response slippage scale, quote expiry, and settlement evidence. Obtain the complete Binance RFQ EIP-712 schema and SWAP ABI/recipient/chain semantics from official versioned documentation or provider clarification. Only then add sanitized, provenance-tracked fixtures and deterministic contract tests. A live read-only quote should be considered only after the exact endpoint/command and isolated environment are documented as read-only and explicitly authorized.

## Final decision

**B. PARTIAL_PROVIDER_SEMANTICS_ESTABLISHED**

This decision recognizes documented command, field, amount, and status semantics only. It does not establish full provider compatibility or authorize execution.
