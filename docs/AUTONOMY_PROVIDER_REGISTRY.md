# WOLV autonomy provider registry

## Purpose

The autonomous worker must not call a market or execution vendor directly. It resolves a configured adapter through `services/autonomy/provider-registry.ts`. Strategy evaluation, portfolio policy, intent persistence and paper accounting remain outside vendor adapters.

## Adapter boundary

Each adapter declares:
- A stable provider ID.
- Supported chain IDs.
- Whether its server-side configuration is present.
- A normalized quote operation for position exits.
- A same-provider, two-sided round-trip quote operation for entries.
- An unsigned order-builder operation.

The registry:
- Enforces unique provider IDs.
- Orders candidates using `WOLV_AUTONOMY_PROVIDER_ORDER`.
- Excludes unconfigured adapters and unsupported chains.
- Tries configured adapters in order when obtaining a complete round-trip quote.
- Rejects provider identity mismatches.
- Never combines the buy quote from one provider with the sell quote from another.
- Returns the selected adapter with the quote so the worker builds the unsigned order through that same provider.

## Current implementation status

The Binance Web3 aggregator is registered as the first adapter and supports BSC chain ID `56`. The worker's entry quote, unsigned RFQ build and paper exit quote calls now pass through the registry instead of importing Binance provider functions directly.

This is an abstraction milestone, **not provider independence yet**:
- Binance remains the only adapter registered in the current worker registry. The isolated 1inch adapter implements the new generic contract but is not yet wired into worker selection.
- The current normalized quote and prepared-order payloads still use Binance-shaped validated models.
- No second quote or execution adapter is active.
- No provider failover can occur until another compatible adapter is implemented and configured.
- A second provider must prove support for the WOLV asset universe, chain, quote freshness, token taxes, gas/fee evidence, transaction construction and a compatible unattended signing model before it can be enabled.
- The registry does not make Binance RFQ signing portable. Each execution adapter must declare and validate its own signing scheme and transaction semantics.

## Configuration

Optional server-side preference:

```dotenv
WOLV_AUTONOMY_PROVIDER_ORDER=binance-web3-aggregator
```

Comma-separated IDs define preference order. Unknown, unconfigured and chain-incompatible IDs are ignored. If no adapter is eligible, the worker fails closed. Do not add a provider ID until its adapter is implemented and tested.

## Candidate for the second execution adapter

**1inch Classic** is now implemented as an isolated adapter against the new vendor-neutral `AutonomousExecutionAdapter` contract. It remains the first second-provider candidate to integrate into the worker. Its official capability matrix lists BNB Chain (56), Classic Swap and Intent-based Swap support, and RWA support; however, it explicitly notes that availability varies by tokenized asset, issuer, network, eligibility, market hours and liquidity. This implementation is a transaction-construction adapter, not proof that every WOLV-listed token is routable or that its risk evidence satisfies WOLV policy. See the [1inch Swap API supported modes and chains](https://portal.1inch.dev/documentation/apis/swap/introduction).

The adapter must not be enabled until it can produce all risk inputs WOLV currently requires (fresh two-sided quotes, exact amounts, token decimals/taxes, USD fee evidence and price impact) and its transaction build/sign/settlement flow has been independently validated. 1inch Classic Swap transactions are not interchangeable with Binance EIP-712 RFQ orders; they require a separate typed execution path.

## Required next work

1. Move the validated quote/order models into vendor-neutral contracts; keep vendor parsing in adapter modules.
2. Implement and test a second BSC quote/execution adapter against supported RWA tokens.
3. Add provider health/circuit-breaker state and cooldowns; do not repeatedly hit a failing provider every worker poll.
4. Add per-provider signing and transaction-simulation capability declarations.
5. Persist provider identity and idempotency metadata on every live intent, then reconcile provider status independently against chain settlement.
6. Keep live signing disabled until custody authorization, policy-constrained signing and restart-safe live execution are complete.
