# BSC RPC preflight adapter

**Status:** implemented as a read-only infrastructure adapter; not yet connected to the autonomous paper/live worker.

## Capabilities

`services/autonomy/bsc-rpc.ts` provides a minimal JSON-RPC client that:
- Verifies the remote endpoint is BNB Smart Chain mainnet (chain ID 56) before account/transaction reads.
- Requires HTTPS for remote RPC endpoints; plain HTTP is permitted only for localhost.
- Reads BNB gas price and native balance as exact integer strings.
- Reads ERC-20 `balanceOf` at latest or an explicit block tag.
- Simulates an exact unsigned transaction using `eth_call` at pending state and `eth_estimateGas`.
- Reads and validates mined transaction receipts, including status, block, gas used and effective gas price.

`services/autonomy/bsc-evm-simulator.ts` adapts the RPC client to the common EVM transaction simulator contract. It binds the simulation to the prepared wallet, target, calldata, value, gas price and gas limit, and rejects an expired quote, wrong chain or gas estimate exceeding the prepared limit.

## Security boundary

The adapter exposes no transaction signing or broadcast method. It does not call `eth_sendTransaction` or `eth_sendRawTransaction`. It is intended for 1inch Classic-style unsigned EVM transactions; it does not replace Binance RFQ EIP-712 validation or settlement verification.

## Remaining integration work

- Wire the simulator into a durable live execution state machine only after signer and custody authorization.
- Independently value gas in USD using a fresh BNB/USD source; raw gas price and gas units are not a USD fee.
- Add pre-trade native-gas reserve policy and transaction-target/router allowlists.
- Persist pre-trade and post-trade token balances at pinned block heights before using balance deltas as settlement evidence.
- Verify RPC provider reliability, rate limits, chain finality and reorg behavior for the deployment environment.

The RPC adapter is not a live execution authorization and has not been run against the user's configured RPC endpoint.
