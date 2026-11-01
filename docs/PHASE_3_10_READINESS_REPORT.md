# WOLV Phase 3.10 — Readiness Report

**Date:** 2026-11-01  
**Decision:** **A. PROVIDER_SEMANTICS_UNRESOLVED**

## 1. Executive summary

The Phase 3.10 UI and regression checks now run against a production build and deterministic fixtures. Seven viewport widths passed for fixed and dynamic stock/trade routes, and the interactive browser-wallet and agent refusal checks passed. The PostgreSQL integration suite and the previously skipped BAW persistence test also passed against disposable PostgreSQL containers.

An evidence-backed BAW settlement risk was closed fail-closed: a provider `FINISHED` status and an undocumented output quantity are no longer treated as a verified fill. WOLV retains the reported quantity for display but records `FINISHED_UNVERIFIED`.

Provider compatibility is still not established. Available documentation does not define BAW output quantity units, token-decimal semantics, or independent settlement evidence. Binance RFQ documentation leaves the EIP-712 domain and message fields opaque; generic SWAP transaction documentation does not establish all calldata and recipient semantics. No genuine provider response was captured, and no live quote or execution call was made.

**No live order, wallet transaction signature, on-chain approval, transaction, or broadcast was performed. The browser test used only a mocked message-auth response; it was not a cryptographic wallet signature. Execution remains disabled and fail-closed.**

## 2. BAW quantity and settlement findings

| Finding | Classification | Evidence and result |
|---|---|---|
| `--fromTokenQty` input convention | VERIFIED | The Binance Agentic Wallet CLI reference describes the input as a human-readable quantity. WOLV uses a human-readable amount rather than passing an 18-decimal integer directly. |
| Input slippage convention | VERIFIED | The CLI reference documents slippage as a percentage. The quote command construction uses that percentage convention. |
| Quote output quantity units | UNVERIFIED | The CLI example contains decimal-looking `fromCoinAmount` and `toCoinAmount` values, but does not normatively specify their units or token-decimal semantics. |
| `toTokenActualQty` units and minimum-output comparison | UNVERIFIED | The order example does not define actual output units or document a minimum-output guarantee that WOLV can independently verify. |
| RWA token-decimal metadata | PARTIALLY_VERIFIED | The quote service requires decimal metadata, but the shared RWA record parser does not expose it. WOLV must not infer 18 decimals; assets without authoritative metadata remain ineligible for a quantity-dependent quote. |
| `FINISHED` settlement meaning | PARTIALLY_VERIFIED | CLI documentation describes `FINISHED` as successful execution, but does not establish independent settlement confirmation or prove actual output quantities. |
| Quote identity, expiry, wallet/session binding | UNVERIFIED | The documented quote example does not establish a provider quote ID, expiry, or wallet binding. WOLV-local binding and expiry are integrity controls, not provider guarantees. |
| Output verification behavior | FIXED_AND_TESTED | `compareBawOutputQuantity` now always returns `FINISHED_UNVERIFIED`; any provider-reported actual output is retained only for display and reconciliation. |

No BAW CLI command was run in this phase. The CLI documentation is not a captured provider response, and examples are not genuine fixtures.

## 3. Binance RFQ contract findings

The provider-maintained connector documentation describes an RFQ response envelope, a signing-wallet association, submission fields, an idempotency window, and order-status fields. It describes `FILLED` quantities as smallest-unit integer strings.

It does **not** establish the complete EIP-712 domain name/version, chain ID, verifying contract, primary type, message field definitions, nonce/request identity within the signed message, or signed-message expiry. The typed data is opaque in the available response model.

| Finding | Classification | Result |
|---|---|---|
| RFQ envelope and order lifecycle | PARTIALLY_VERIFIED | Provider documentation describes the general flow and selected fields. |
| Complete EIP-712 signing contract | BLOCKED_EXTERNAL_DEPENDENCY | Critical domain/message and expiry semantics are unavailable. |
| WOLV RFQ signing/submission compatibility | VERIFIED | WOLV continues to reject unsupported RFQ signing and submission payloads. No signing or submission was attempted. |

## 4. Binance SWAP contract findings

Provider-maintained documentation describes a generic SWAP transaction envelope with optional sender, destination, calldata, native value, gas, minimum-receive, and slippage fields. It does not establish the ABI/function selector, calldata argument semantics, an independently verifiable recipient, or a complete transaction-level chain binding. Approval response fields are also optional.

The same documentation identifies RWA/equity quote routes as RFQ. WOLV continues to reject unsupported SWAP payloads and does not forward them to wallet submission.

| Finding | Classification | Result |
|---|---|---|
| Generic SWAP envelope field meanings | PARTIALLY_VERIFIED | Some meanings are documented, but the complete transaction contract is not. |
| RWA route mode | VERIFIED | Provider documentation identifies RWA/equity routes as RFQ. |
| Unsupported SWAP and approval transaction handling | VERIFIED | Unsupported payloads remain fail-closed; no transaction was submitted. |
| Live Binance compatibility | UNVERIFIED | No genuine provider response or live compatibility test was used. |

## 5. Dynamic route test results

The isolated production-build responsive runner passed at **320, 360, 390, 414, 768, 1024, and 1440 px**:

- Six fixed routes: `/`, `/gap`, `/markets`, `/trade`, `/wallet`, and `/agent`.
- Seven dynamic stock/trade cases: valid token, malformed token, missing token, and unavailable market data.
- Horizontal overflow checks on all tested routes and viewport widths.
- Wallet-control and agent-terminal layout checks.

This amounts to 91 route/viewport checks (42 fixed-route and 49 dynamic-route checks). All provider and market responses were deterministic test fixtures; no live quote was requested.

## 6. Interactive approval/refusal results

The user-facing checks passed with a mocked injected wallet and mocked API responses:

- Disconnected browser wallet: quote action unavailable.
- Connected browser wallet: mocked quote/loading state and accurate six-decimal output display.
- Unsupported execution: clear quote-only refusal; no approval or execution action.
- Expired quote and quote error: shown as non-executable.
- BAW authorization: quote remains disabled until authorization; rejected and expired quotes have no approval action.
- AI trigger simulation remains a mock recommendation and cannot authorize execution.
- No transaction endpoint, transaction signing, on-chain approval, or broadcast was performed. The mocked agent-auth flow may return a constant message-signature fixture; it is not cryptographic, is not produced by a real wallet, and is not provider evidence.

The test runner initially exposed two harness issues: one DevTools navigation timeout and a lost mock-wallet connection after navigation. After persisting the mock connection in session storage, the final full responsive run passed. The navigation timeout did not recur on the successful run.

## 7. Files changed

Phase 3.10 changes recorded for this report:

- `services/bawExecution.ts` — retain `FINISHED_UNVERIFIED` when BAW output/settlement evidence is insufficient.
- `scripts/baw-execution.test.mjs` — test undocumented quantity/settlement semantics across sample amounts and decimal counts.
- `scripts/responsive-smoke.mjs` — production server lifecycle, dynamic route and interactive refusal coverage; persist mocked injected-wallet state across navigation.
- `scripts/responsive-fixtures.mjs` — deterministic market/API fixture support for the responsive cases.
- `docs/PHASE_3_10_READINESS_REPORT.md` — this report.

Other modified or untracked files in the worktree belong to earlier phases and were not reverted or represented as Phase 3.10 changes.

## 8. Regression results

| Command | Result |
|---|---|
| `npm run test:logic` without BAW database URL | PASS — 261 passed, 0 failed, 1 skipped. The skip is the BAW PostgreSQL persistence test gated on `BAW_TEST_DATABASE_URL`. |
| `BAW_TEST_DATABASE_URL=<disposable PostgreSQL URL> npm run test:logic` | PASS — 262 passed, 0 failed, 0 skipped. The BAW persistence test is distinct from the separate PostgreSQL integration suite and passed across independent store instances. |
| `npm run test:hardening` | PASS — remote hardening smoke checks passed against `https://wolv-stock.vercel.app`; this is not provider-contract evidence. |
| `npm run test:responsive` | PASS — production build and responsive/interactive checks passed at all seven widths. A prior attempt timed out; the final run passed after correcting mock-wallet persistence. |
| `npm run test:postgres` | PASS — 4/4 against disposable PostgreSQL 16. The container was stopped and removed. |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS — 0 errors, 6 warnings. Warnings are unused symbols/parameters in `TradeButton.tsx`, `binanceExecutionValidation.ts`, `browser-trading-hardening.test.mjs`, `browserTradeIntentStore.ts`, and `browserTradeQuote.ts`. |
| `npm run build` | PASS — production build completed. The responsive runner also independently built the production app. |

## 9. Remaining blockers

1. **BAW output and settlement contract:** output-unit and token-decimal semantics, minimum-output guarantee, and independent settlement evidence remain undefined.
2. **BAW decimals:** the shared RWA asset parser does not provide authoritative decimals needed for amount normalization. Do not add a guessed default.
3. **Binance RFQ:** complete EIP-712 fields and expiry semantics remain unavailable; keep signing/submission disabled.
4. **Binance SWAP:** calldata and recipient semantics remain incomplete; keep unsupported transaction payloads rejected.
5. **Genuine provider evidence:** no sanitized provider response was captured. Deterministic mocks establish only application behavior, not provider compatibility.
6. **Live BAW quote retrieval:** not verified. No CLI quote command or provider call was made.

## 10. Evidence provenance

- **AUTHORITATIVE_DOCUMENTATION:** Binance-maintained Agentic Wallet CLI reference and the pinned Binance Web3 connector documentation cited in [the Phase 3.9 report](./PHASE_3_9_PROVIDER_CONTRACT_REPORT.md).
- **GENUINE_SANITIZED_PROVIDER_FIXTURE:** none.
- **MOCKED_TEST_FIXTURE:** responsive browser/API fixtures and BAW unit-test runner responses. They test WOLV behavior only and are not provider evidence.
- **UNVERIFIED_ASSUMPTION:** any undocumented BAW quantity, expiry, settlement, or Binance EIP-712 semantics. No such assumption is treated as verified behavior.

## 11. Current execution restrictions

- BAW execution remains disabled by configuration and existing fail-closed gates.
- Binance RFQ signing/submission and unsupported SWAP transaction payloads remain rejected.
- No live order, real wallet signature, transaction broadcast, contract deployment, production configuration change, or production database modification was made.
- No mock fixture is presented as genuine provider data.

## 12. Recommended next phase

Keep execution disabled. Obtain authoritative provider documentation or genuine sanitized, non-executing provider evidence for BAW output units, token decimals, minimum-output semantics, quote expiry, and settlement/reconciliation. Obtain the complete Binance RFQ typed-data contract and transaction semantics before implementing any adapter. Then add compatibility tests against those verified contracts. Do not proceed to execution enablement until each critical contract is established and independently reviewed.

## Final decision

**A. PROVIDER_SEMANTICS_UNRESOLVED**
