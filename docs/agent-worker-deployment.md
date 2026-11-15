# Persistent autonomous agent worker deployment

The web application and the persistent trading worker are separate processes. A serverless web deployment does not keep `worker/agentWorker.ts` alive. Deploy this worker as a dedicated, always-on container/process with restart-on-failure enabled.

## Testnet-only deployment

Build the image from the repository root:

```bash
docker build -f Dockerfile.agent-worker -t wolv-agent-worker .
```

Run it with environment variables injected by the hosting platform or a secret manager. Do not bake secrets into the image or commit an env file:

```bash
docker run --restart unless-stopped --env-file .env.worker wolv-agent-worker
```

The worker loads process environment directly. For local operation, it also loads `.env`, `.env.local`, and optional `.env.worker`.

Required worker environment:

- `WOLV_AGENT_DATABASE_URL` (or `WOLV_TRADING_DATABASE_URL`): persistent PostgreSQL connection string.
- `AGENT_PRIVATE_KEY`: dedicated 32-byte delegated intent signer key. Never use the owner's wallet key or the deployment/guardian key.
- `WOLV_AUTONOMOUS_TRADING_ENABLED=true`: master autonomous execution gate.
- `ENABLE_LIVE_USEROP_SUBMISSION=true`: enables live UserOperation submission.
- `NEXT_PUBLIC_CHAIN_ID=97` (or `CHAIN_ID=97`): BSC testnet.
- `NEXT_PUBLIC_BSC_TESTNET_RPC_URL`: BSC testnet RPC endpoint.
- `NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL`: compatible BSC testnet ERC-4337 bundler endpoint.
- `NEXT_PUBLIC_ROUTER_ADDRESS`: verified BSC testnet PancakeSwap V2 router.
- `NEXT_PUBLIC_POLICY_HOOK_ADDRESS`: deployed `TradingAgentPolicyValidatorV2` address.
- `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS`: exact token authorized by the policy.

The database must be reachable from the worker host. Use a dedicated restricted database role and TLS where supported. Keep the delegated signer key in the host's secret store, restrict access to worker operators, and fund it only as required for the testnet session.

## Before starting the worker

1. Deploy V2 to BSC testnet and verify the deployment bytecode and constructor configuration.
2. Configure the guardian-allowlisted BNB/USD and target-token/USD Chainlink feeds; verify feed descriptions, decimals, freshness, and network addresses independently.
3. Install the V2 hook on the Kernel smart account and configure its owner-authorized policy. The policy's intent signer must equal the address derived from `AGENT_PRIVATE_KEY`.
4. Create the matching `BSC_AGENT_TRADE` schedule through the owner-authenticated schedule API. The schedule's strategy ID, account, token, amount, entry ceiling, slippage, and price-impact limit must exactly match the V4 policy commitment.
5. Start one worker instance initially. Confirm its heartbeat appears in the schedule API and that it claims the due schedule only once.

## Acceptance test

A schedule is not proof of execution. Acceptance requires all of the following on BSC testnet:

- Worker heartbeat is current.
- A trigger-matching evaluation emits a bounded intent without a per-trade owner signature.
- The executor submits a UserOperation and records its hash.
- The bundler receipt resolves to a successful transaction receipt.
- The transaction is visible on the BSC testnet explorer and the smart-account/token balances reflect the execution.
- The persistent claim reaches its terminal state and the schedule reschedules.
- A second worker cannot claim the same execution concurrently.
- Pause, policy expiry, signer revocation, stale feed, stale quote, price-impact breach, and emergency stop all prevent new execution.
- An uncertain post-submission result leaves the schedule disabled/locked until reconciled; it must not blindly resubmit.

## Safety boundary

Do not set `ENABLE_MAINNET_AGENT_TRADING` or `MAINNET_AGENT_TRADING_ACK` for this testnet deployment. Keep the application and worker configured for chain ID 97. Do not move to mainnet based on unit tests, a worker heartbeat, a quote, or a submitted UserOperation alone. Require a confirmed testnet transaction and the full negative-path acceptance test first.

The worker is intentionally a separate long-running process. Configure the host to restart it on process failure, alert on missing heartbeats, and run only one instance until the database claim/lease behavior has been verified under concurrency.
