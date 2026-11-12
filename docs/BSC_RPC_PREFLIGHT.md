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

`services/autonomy/bsc-evm-simulator.ts` adapts the RPC client to the common EVM transaction simulator contract. It binds the simulation to the prepared wallet, target, calldata, value, gas price and gas limit, and rejects an expired quote, wrong chain or gas estimate exceeding the prepared limit.\n\n`services/autonomy/bsc-settlement-verifier.ts` independently checks a mined transaction, sender, exact prepared router target, BSC chain, confirmation depth, ERC-20 Transfer logs for the configured input/output tokens, exact net input debit, minimum net output credit, and actual fee in wei. Provider acknowledgement alone cannot produce `SETTLED`.

## Security boundary

The adapter exposes no transaction signing or broadcast method. It does not call `eth_sendTransaction` or `eth_sendRawTransaction`. It is intended for 1inch Classic-style unsigned EVM transactions; it does not replace Binance RFQ EIP-712 validation or settlement verification.

## Remaining integration work

- Wire the simulator into a durable live execution state machine only after signer and custody authorization.
- Independently value gas in USD using a fresh BNB/USD source; raw gas price and gas units are not a USD fee.
- Add pre-trade native-gas reserve policy and transaction-target/router allowlists.
- Add durable persistence for transaction hash, prepared payload hash, actual transfer amounts, block number and fee evidence.\n- Validate trusted router/allowance contracts before signing; this verifier only proves that the mined transaction matched the target already authorized by upstream policy.
- Verify RPC provider reliability, rate limits, chain finality and reorg behavior for the deployment environment.

The RPC adapter is not a live execution authorization and has not been run against the user's configured RPC endpoint.
\nTests: `scripts/bsc-rpc.test.mjs`, `scripts/bsc-evm-simulator.test.mjs`, and `scripts/bsc-settlement-verifier.test.mjs`. They are committed but have not been executed in this environment.\n