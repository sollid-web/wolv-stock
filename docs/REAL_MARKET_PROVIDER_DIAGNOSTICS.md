# Real Market Provider Diagnostics

## Status

**BLOCKED_EXTERNAL_DEPENDENCY**: signed Binance provider verification was attempted, but the configured credentials returned Binance error `40103` with HTTP `401`. A credential-free asset-list request returned `40101` ("API Key is required").

## Safe live capture

No asset addresses, returned amounts, route counts, quote decimals, or `tokenUnitPrice` values were available for NVDA, AAPL, or TSLA because the provider rejected authentication before asset-list data was returned.

| Provider request | HTTP status | Binance error code | Result |
|---|---:|---:|---|
| RWA asset list (signed local credentials) | 401 | 40103 | Authentication rejected; no asset records |
| RWA asset list (no credentials) | 401 | 40101 | API key required |
| Read-only aggregator quote for NVDA/AAPL/TSLA | Not reached | Not reached | Authentication blocked asset discovery |

No credentials, signatures, wallet secrets, or full provider payloads are recorded in this document.

## Failure isolation

- Provider request: **confirmed blocked by authentication**
- Asset-list parser: **not reached against a real response**
- Missing reference fields: **not determinable from the blocked response**
- Quote response parser and price validation: **not determinable from the blocked response**

The configured API key and secret must be refreshed or corrected before real-provider capture can proceed.

## Market-monitor separation

Public market monitoring now uses `marketQuoteUsd` and does not apply wallet-execution authorization or reference-gap rejection. Public views still:

- display valid asset-list reference prices independently of indicative quotes;
- label indicative quotes as unavailable when provider or route validation fails;
- never reuse stale prices or infer a live price from reference data;
- retain the existing trade preflight and browser-wallet strict validation.
