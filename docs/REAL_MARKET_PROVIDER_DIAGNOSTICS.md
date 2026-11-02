# Real Market Provider Diagnostics

## Status

**VERIFIED_LOCALLY, VERCEL_CREDENTIALS_UNVERIFIED**: the `.env.local` values contained trailing whitespace; after trimming, the production HMAC helper returned HTTP `200`, Binance `code: 0`, and 488 RWA assets. The provider is no longer locally blocked, but Vercel credentials still require authenticated CLI access.

## Safe live capture

No asset addresses, returned amounts, route counts, quote decimals, or `tokenUnitPrice` values were available for NVDA, AAPL, or TSLA because the provider rejected authentication before asset-list data was returned.

| Provider request | HTTP status | Binance error code | Result |
|---|---:|---:|---|
| Previous signed RWA asset-list attempt with untrimmed credentials | 401 | 40102 / 40103 | Authentication rejected; configuration whitespace was the probable cause |
| RWA asset list with trimmed credentials and production HMAC helper | 200 | 0 | 488 asset records |
| RWA asset list (no credentials) | 401 | 40101 | API key required |
| Read-only aggregator quote for NVDA/AAPL/TSLA | Not reached | Not reached | Authentication blocked asset discovery |

No credentials, signatures, wallet secrets, or full provider payloads are recorded in this document.

## Failure isolation
-
- Provider request: **verified locally after credential whitespace trimming**
- Asset-list parser: **verified with a non-empty 488-record response**
- Missing reference fields: **tested against real NVDA, AAPL, and TSLA records**
- Quote response parser and independent price validation: **verified for successful routes**

Authenticated provider capture now proceeds with the local credentials. Vercel deployment credentials must be verified through an authenticated Vercel session before declaring the production deployment recovered.

## Real provider evidence

The production signing helper produced:

- Asset-list HTTP `200`
- Binance code `0`
- 488 assets
- Fresh timestamps and unique diagnostic request IDs

Real asset records captured:

| Ticker | Platform | Token address | Reference price | Token/share ratio | Listed token price |
|---|---|---|---:|---:|---:|
| NVDA | bStock | `0x02fca66c1d1afb4e2a7884261eb00f63598a7436` | 207.83 | 1.000778223752807865 | 207.99173824254605858295 |
| NVDA | Ondo | `0xa9ee28c80f960b889dfbd1902055218cba016f75` | 207.95751710113802 | 1.0017152487959898 | 208.314215981962775232360392312196 |
| AAPL | Ondo | `0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4` | 345.65553208295313 | 1.003376073740221058 | 346.82249064798052548445499965301154 |
| TSLA | bStock | `0x5b1910eaad6450e50f816082aa078c41f10c292f` | 401.03 | 1.000000000000000000 | 401.03 |
| TSLA | Ondo | `0x2494b603319d4d9f9715c9f4496d9e0364b59d93` | 400.625714 | 1 | 400.625714 |

Successful read-only quote routes had HTTP `200`, Binance code `0`, and returned:

- NVDA bStock: `SWAP`, 18/18 decimals, `tokenUnitPrice` present, per-share estimate 207.6056, reference gap -0.0543%
- NVDA Ondo: `SWAP`, 18/18 decimals, `tokenUnitPrice` present, per-share estimate 208.8160, reference gap 0.5653%
- AAPL Ondo: `SWAP`, 18/18 decimals, `tokenUnitPrice` present, per-share estimate 348.1619, reference gap 1.0666%
- TSLA bStock: `SWAP`, 18/18 decimals, `tokenUnitPrice` present, per-share estimate 400.5329, reference gap -0.1190%
- TSLA Ondo: code `40374`, no route

## Market-monitor separation

Public market monitoring now uses `marketQuoteUsd` and does not apply wallet-execution authorization or reference-gap rejection. Public views still:

- display valid asset-list reference prices independently of indicative quotes;
- label indicative quotes as unavailable when provider or route validation fails;
- never reuse stale prices or infer a live price from reference data;
- retain the existing trade preflight and browser-wallet strict validation.

## Vercel credential verification

The repository is linked to Vercel project `wolv-stock`, but the CLI timed out during both `vercel whoami` and production environment retrieval. No Vercel environment variable values were read or printed.

Local `.env.local` credentials:

- API key configured
- Secret configured
- Both contained trailing whitespace
- Trimmed lengths are consistent with usable key/secret syntax
- The production HMAC helper succeeded after trimming

Vercel credential parity remains unverified until an authenticated Vercel CLI session can inspect production environment names and values without exposing them.

## Acceptance status

Current classification: `BLOCKED_MARKET_PROVIDER_AUTHENTICATION_UNRESOLVED`

Local provider authentication is verified. The original authentication blocker is resolved for local execution, and the real-provider regression passes. The remaining blocker is production/Vercel credential verification. The market feed should not be declared restored in production until that check passes.
