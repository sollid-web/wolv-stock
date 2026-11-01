# Phase 3.14 — Live BSC Asset Metadata Verification Report

**Report prepared:** 2026-11-01T06:50:08Z  
**Decision:** `LIVE_METADATA_AUDIT_NOT_PERFORMED`  
**Evidence status:** `UNVERIFIED`

## 1. Executive summary

The Phase 3.14 audit runner and deterministic mocked tests are implemented. The runner defaults to dry-run and requires two separate interactive confirmations before it can make the catalogue request and BSC RPC reads. It only accepts the trusted catalogue response and the configured BSC USDT address; command-line token-address input is not supported.

The live audit was not run. No catalogue request, BSC RPC read, BAW operation, wallet signature, approval, transaction, or broadcast was performed. Therefore there is no eligible-asset count, catalogue snapshot hash, live block, live decimal result, or live RPC verification classification. Mock tests are `MOCK_VERIFIED` only and are not live evidence.

## 2. RPC configuration security assessment

- `NEXT_PUBLIC_BSC_RPC_URL` is browser-visible under Next.js environment-variable semantics. It remains limited to an uncredentialed public endpoint, and validation rejects URL credentials, non-root paths, query parameters, and fragments.
- Server metadata and server smart-account code prefer `BSC_RPC_URL` for authenticated/private RPC access. These modules are marked `server-only`; the server URL is not rendered into the browser bundle.
- The public uncredentialed BSC endpoint fallback is retained.
- RPC identities in the audit plan are reduced to protocol, host, optional port, and `/<redacted>`. Credentials, URL paths, and query parameters are not printed or written to audit output. Error messages do not include raw environment values.
- An optional second RPC is used only when both operator labels are supplied and differ. Those labels are operator-asserted; different URLs or labels alone do not independently prove distinct infrastructure operators.
- No environment variable value or credential was inspected for this report.

## 3. Catalogue snapshot details

The runner is configured to request:

```text
GET https://web3.binance.com/build/api/v1/dex/market/rwa/tokens
```

It uses the existing signed Binance Web3 request-header helper. Credential values are not printed. The response is shape-checked, reduced to an allowlist of catalogue fields, passed through the existing parser and spot-eligibility rules, and hashed as a sanitized normalized snapshot.

No request was made. Accordingly:

| Field | Result |
|---|---|
| Catalogue snapshot | `UNVERIFIED` |
| Eligible assets | Unknown; no catalogue fetched |
| Sanitized catalogue SHA-256 | Not available |
| Duplicate eligible addresses | Not checked |

The audit result/status artifact is [phase-3-14-live-metadata-verification.json](./audits/phase-3-14-live-metadata-verification.json). It intentionally contains no fabricated per-asset rows.

## 4. Audit procedure and exact planned requests

Run the script without arguments for dry-run. It displays the BSC network, chain ID, catalogue URL, redacted RPC identities, planned methods, and no-BAW/no-transaction guarantees. It makes no network requests in that mode.

Live mode is `--live-read-only`. The runner requires an interactive terminal and these separate exact confirmations:

1. `READ-ONLY CATALOGUE` — permits only the signed catalogue GET. After that response is sanitized, the runner displays the eligible-asset count and the RPC plan.
2. `READ-ONLY BSC RPC` — permits the RPC reads. A wrong or absent confirmation stops the audit before the next request.

The catalogue count cannot be known before fetching the catalogue. The runner therefore displays it after the first explicitly authorized, read-only catalogue request and before requesting authorization for any RPC reads.

If RPC reads are authorized, the methods and sequence are:

1. Primary endpoint: `eth_chainId`; stop unless it returns 56.
2. Primary endpoint: `eth_blockNumber`, then `eth_getBlockByNumber` for that captured block; retain the block number and hash.
3. Optional secondary endpoint, only with distinct operator labels: `eth_chainId`, then `eth_getBlockByNumber` for the *same* primary block number. A chain or block-hash mismatch is `RPC_DIVERGENCE`; results are not combined.
4. For each unique, eligible catalogue token address and configured BSC USDT (`0x55d398326f99059fF775485246999027B3197955`), call `eth_getCode` and then `eth_call` for `decimals()` at the captured block. Repeat the same reads at the secondary endpoint only after its chain and block hash match.
5. If code is absent, do not call `decimals()`. Reverts, malformed values, unsupported decimals, metadata conflicts, and endpoint disagreements remain explicit failures.

Thus, for a successful single-RPC run with `N` unique eligible assets, the primary would make three snapshot/network calls and up to `2 × (N + 1)` contract reads; the additional `+1` is USDT. A configured secondary adds two chain/block checks and up to `2 × (N + 1)` contract reads if the block matches. Failed or unsupported contracts can reduce the number of calls. No wallet client or transaction-writing method is present in the audit client interface.

## 5. BSC network and block evidence

No live chain ID, block number, or block hash was collected. Status: `UNVERIFIED`.

The implementation pins code and `decimals()` calls to the recorded block. It records a SHA-256 digest of contract bytecode rather than storing the full bytecode. Proxy contracts are read through their catalogue address at that block; there is no metadata cache, so no stale cache fallback or cache freshness policy is involved. The bytecode digest identifies the address's code at the recorded block but does not independently identify a proxy implementation or establish future upgrade behavior.

## 6. Per-asset metadata results

No live assets were audited. The per-asset result list is empty because a catalogue snapshot was not obtained.

The mocked suite covers:

- Eligible/ineligible catalogue records and duplicate addresses.
- Invalid addresses rejected before contract reads.
- Decimal values 0, 6, 8, and 18.
- Missing code, reverted reads, malformed ABI values, and values above WOLV's supported maximum of 18.
- Catalogue decimal conflicts.
- Block-pinned primary and secondary reads, block/chain mismatch, and code/decimal divergence.
- Independent USDT handling and USDT metadata failure.
- RPC operator-label requirements and credential/path/query redaction.
- Dry-run behavior, rejected arbitrary command arguments, and confirmation phrase validation.
- The audit client's read-only method surface.

These are deterministic mocks, not chain evidence.

## 7. USDT metadata result

USDT is configured from the existing BSC token-address constant and is resolved independently from each audited asset at the same block. No live USDT code or `decimals()` result was collected; status is `UNVERIFIED`. No decimal default is applied.

## 8. RPC verification classification

No live RPC endpoint was contacted. The report does not classify evidence as single-RPC or cross-RPC. A future cross-RPC attempt requires explicit distinct operator labels as well as a configured secondary URL; the labels are operator assertions and do not by themselves prove independent ownership.

## 9. Unsupported contracts, conflicts, and failures

No live contract failures or metadata conflicts were observed because no live audit occurred. The implementation records failures per asset as `UNSUPPORTED` and endpoint/block disagreements as `RPC_DIVERGENCE`. It does not substitute catalogue decimals, cached values, or a universal default when an on-chain call fails.

## 10. Files changed

Phase 3.14 implementation, tests, configuration guidance, and this report:

- `.env.example`
- `README.md`
- `lib/binance.ts`
- `lib/binanceAuth.ts`
- `lib/bscMetadataAudit.ts`
- `lib/publicRpcUrl.ts`
- `lib/smartAccount.ts`
- `lib/wagmi.ts`
- `package.json`
- `pnpm-lock.yaml`
- `scripts/bsc-metadata-audit.mjs`
- `scripts/bsc-metadata-audit.test.mjs`
- `scripts/responsive-smoke.mjs`
- `scripts/smart-account.test.mjs`
- `services/bscTokenMetadata.ts`
- `docs/PHASE_3_14_LIVE_METADATA_VERIFICATION_REPORT.md`
- `docs/audits/phase-3-14-live-metadata-verification.json`

The `lib/binance.ts` change routes existing signed submissions through the shared server-side signing helper; it does not add or invoke any provider operation in this audit.

## 11. Test results

| Check | Result |
|---|---|
| BSC metadata audit mocked tests | 20/20 passed |
| `npm run test:logic` | 337 passed, 0 failed, 1 skipped |
| `npm run test:hardening` | Passed against the local build |
| `npm run test:responsive` | Passed at 320, 360, 390, 414, 768, 1024, and 1440 px |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | Passed with 6 warnings |
| `npm run build` | Passed |
| `npm run test:postgres` | Blocked: `TEST_POSTGRES_URL` is not configured |

The single skipped logic test is `PostgreSQL execution records survive independent store instances`, because `BAW_TEST_DATABASE_URL` is unset. `TEST_POSTGRES_URL` was also unset. A local PostgreSQL server answered readiness checks, but the current local role has no matching PostgreSQL role and administrative access was unavailable; no database was created or modified. The PostgreSQL integration checks therefore remain unverified.

The six lint warnings are outside the Phase 3.14 audit files:

- `components/TradeButton.tsx:346` — unused `checkApproval`.
- `lib/binanceExecutionValidation.ts:78,86` — unused `_response` and `_typedData`.
- `scripts/browser-trading-hardening.test.mjs:190` — unused `t`.
- `services/browserTradeIntentStore.ts:1` — unused `timingSafeEqual`.
- `services/browserTradeQuote.ts:73` — unused `error`.

Responsive and hardening checks used local servers, mocked provider data, dummy fixture credentials, and loopback RPC URLs. No real BAW CLI/provider, catalogue, or BSC RPC request was made.

## 12. Remaining BAW provider uncertainties

This audit cannot establish actual BAW quote output semantics, settlement proof, accepted provider quantity units, or provider compatibility. No BAW command or quote was requested.

## 13. Remaining Binance SWAP/RFQ uncertainties

This audit does not establish Binance SWAP calldata semantics, the Binance RFQ typed-data contract, transaction settlement, or execution compatibility.

## 14. Current execution restrictions

No trading architecture or production configuration was enabled. There is no order submission, swap, signature, approval, transaction broadcast, contract deployment, autonomous execution, BAW invocation, or execution worker added by this phase. A successful future `decimals()` read would establish only raw token precision at the audited block—not token legitimacy, share denomination, UI multiplier support, BAW quantity semantics, or provider settlement.

## 15. Recommended next phase

After an operator explicitly authorizes live, read-only access, run the script interactively in `--live-read-only` mode and retain its sanitized per-asset JSON/Markdown output. Review every unsupported result, conflict, and RPC status before making any separate decision about BAW compatibility. This report does not authorize live trading.
