# 1inch Classic adapter — integration status

## Implemented

`services/autonomy/oneinch-classic.ts` implements a separate BNB Chain (56) Classic Swap client:
- Authenticated 1inch API requests using server-side `ONEINCH_API_KEY`.
- Strict quote parsing bound to chain, wallet, token direction and exact base-unit input amount.
- Captures token decimals, expected output, gas estimate, route fingerprint and evidence hash.
- Applies a conservative 10-second local quote-use window. This is WOLV's local safety policy, not a claim that 1inch guarantees a 10-second quote TTL.
- Requests a Classic Swap transaction and validates returned input/output amounts against the original quote and configured slippage floor.
- Validates transaction target, calldata, native value, gas and gas price.
- Implements the vendor-neutral `AutonomousExecutionAdapter` contract in `provider-contracts.ts`, returning normalized quote evidence and an `EVM_TRANSACTION` payload.
- Produces an unsigned transaction fingerprint. It never signs, broadcasts or requests wallet approval.
- Tests cover parsing, binding, expiry, malformed transaction data, API authentication and missing credentials.

## API surface

The client currently targets the documented v6.1 BNB endpoint shape:
- `GET /swap/v6.1/56/quote`
- `GET /swap/v6.1/56/swap`

Official mode and chain support: [1inch Swap API documentation](https://portal.1inch.dev/documentation/apis/swap/introduction). 1inch lists BNB Chain (56), Classic Swap and RWA support, but notes RWA availability varies by asset, issuer, eligibility, market hours and liquidity.

## Why this is not yet registered as a worker fallback

The current WOLV paper worker expects Binance RFQ-specific evidence: vendor, RFQ quote IDs, approval target semantics, token tax rates, USD-denominated fee evidence, and two-sided round-trip data. A Classic Swap transaction is a normal EVM transaction, not a Binance EIP-712 RFQ order.

The 1inch adapter currently does **not** manufacture missing risk data:
- 1inch quote output does not by itself establish WOLV's token transfer-tax/honeypot evidence.
- Its gas estimate is not a USD network-fee value. Converting it requires an independently sourced BNB/USD price and current gas-price evidence.
- Price impact and route details need a validated interpretation for the RWA assets WOLV supports.
- Router/allowance spender addresses need an explicit trusted-contract policy.
- Exact transaction simulation and independent chain settlement verification are not yet wired to this provider path.

Therefore the 1inch client is implemented and unit-tested in isolation, but **not enabled in the autonomous worker**, not eligible for automatic failover, and not authorized to execute real trades. Do not add `1inch-classic` to `WOLV_AUTONOMY_PROVIDER_ORDER`; the existing RFQ registry accepts only the Binance RFQ adapter contract.

## Required before worker integration

1. Add vendor-neutral quote and prepared-transaction contracts without weakening existing Binance RFQ validation.
2. Obtain token decimals/tax/risk metadata from independent sources and fail closed on unknown assets.
3. Convert gas cost to USD using fresh independent BNB price data; include fee buffers and exact integer arithmetic.
4. Validate router and approval spender against a maintained chain-specific allowlist; enforce exact approval amount and revoke policy.
5. Simulate the exact unsigned transaction against a trusted BSC RPC before any signing.
6. Integrate a policy-constrained signer that independently checks chain, wallet, router, token direction, amount, calldata and spend limits.
7. Persist provider-specific idempotency and transaction state; verify receipt and token balance deltas independently of 1inch.
8. Add end-to-end tests with recorded fixtures and an explicitly authorized test wallet before any live pilot.

## Configuration

```dotenv
ONEINCH_API_KEY= # server-side only
```

Never use a `NEXT_PUBLIC_` prefix for this key. No API key or wallet secret belongs in source control or chat.
