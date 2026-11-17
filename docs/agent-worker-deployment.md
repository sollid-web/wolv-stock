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
- `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS`: exact token authorized by the policy. Must not be WBNB, must have a PancakeSwap V2 WBNB pool and a guardian-allowlisted Chainlink USD feed. Testnet candidate: ETH `0xd66c6B4F0be8CE5b39D52E0Fd1344c389929B378` (ETH / USD `0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7`).

The worker refuses to start without a database URL; there is no static or in-memory mode.

### Reference testnet run (verified 2026-11-17)

The verified testnet worker runs against a local, non-production Postgres and a minimal, gitignored env file containing only the keys listed above (no production DB URL, no deployer key):

```bash
docker run -d --name wolv-testnet-pg --restart unless-stopped -e POSTGRES_USER=wolv_test \
  -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=wolv_testnet -p 127.0.0.1:55432:5432 \
  -v wolv-testnet-pg:/var/lib/postgresql/data postgres:16-alpine
docker build -f Dockerfile.agent-worker -t wolv-agent-worker:$(git rev-parse --short HEAD) .
docker run -d --name wolv-agent-worker-testnet --restart unless-stopped --network host \
  --env-file .env.worker.testnet.docker wolv-agent-worker:$(git rev-parse --short HEAD)
```

`NODE_ENV=test` is set in that env file only because the local test DB has no TLS; production images keep `NODE_ENV=production`, which enforces `verify-full` TLS. Trading also requires the owner's global-stop release from `/agent` (time-boxed; the worker fails closed when it lapses). Rehearse changes first with `scripts/fork-agent-e2e.mjs` on an anvil fork.

The database must be reachable from the worker host. Use a dedicated restricted database role and TLS where supported. Keep the delegated signer key in the host's secret store, restrict access to worker operators, and fund it only as required for the testnet session.

## Web application configuration

The web application that owns the schedule-registration API also needs:

- `WOLV_AGENT_CONTROL_PLANE_ENABLED=true` so the schedule UI reports worker readiness.
- `WOLV_AGENT_DATABASE_URL` (or `WOLV_TRADING_DATABASE_URL`) pointing to the same PostgreSQL database used by the worker.
- `BAW_WALLET_API_TOKEN`: random high-entropy server secret of at least 32 bytes.
- `BAW_AUTHORIZED_BROWSER_WALLETS`: comma-separated allowlist of owner wallet addresses.
- `BAW_EXECUTION_DATABASE_URL`: PostgreSQL connection for the short-lived browser wallet session/challenge store.
- `NEXT_PUBLIC_AGENT_SIGNER_ADDRESS`: the PUBLIC address of the worker's delegated signer. The web app never needs `AGENT_PRIVATE_KEY`; do not configure it there.
- The same chain, RPC, bundler, router, V2 hook and target-token configuration used to verify the owner-authorized policy.

The BAW browser session is used once to authorize schedule creation/management. It is not a per-trade approval and does not replace the on-chain owner policy.

## Before starting the worker

1. Deploy V2 to BSC testnet with `pnpm deploy:testnet-policy`. The script only accepts the pinned official Chainlink BNB/USD proxy (`scripts/chainlinkFeeds.mjs`). The V2 instance previously configured at `0xed2f…b465` uses a self-deployed mock feed and must not be used.
2. As guardian, allowlist the target token's official Chainlink USD feed: `pnpm configure:testnet-token-feed -- <V2> <token> <feed> 86400` (testnet ETH/BTC feeds have a 24 h heartbeat).
3. In `/agent`, connected as the smart account's on-chain owner, install the V2 hook and configure the policy. The intent signer must equal `NEXT_PUBLIC_AGENT_SIGNER_ADDRESS` (the address of `AGENT_PRIVATE_KEY`).
4. Save the strategy. The owner signs a session challenge and, once, Kernel's `Enable` typed data authorizing the agent validator. The API verifies both against chain state before storing the `BSC_AGENT_TRADE` schedule.
5. Fund the smart account with enough testnet BNB for the trade amount plus UserOperation gas (no paymaster is configured).
6. Start one worker instance. Confirm its heartbeat appears in the schedule API and that it claims the due schedule only once.

## Acceptance test

A schedule is not proof of execution. Acceptance requires all of the following on BSC testnet:

- Worker heartbeat is current.
- A trigger-matching evaluation emits a bounded intent without a per-trade owner signature.
- The first trade's UserOperation enables the agent validator (Kernel enable mode) and the swap succeeds in the same operation.
- The executor submits a UserOperation and records its hash.
- The receipt contains the V2 `AgentExecutionSucceeded` event and target-token transfers to the account; the claim is `CONFIRMED` with `execution_evidence` (hashes, amounts, balance before/after).
- The transaction is visible on the BSC testnet explorer and the smart-account/token balances reflect the execution.
- The persistent claim reaches its terminal state and the schedule reschedules.
- A second worker cannot claim the same execution concurrently.
- Pause, policy expiry, signer revocation, stale feed, stale quote, price-impact breach, and emergency stop all prevent new execution.
- An uncertain post-submission result leaves the schedule disabled/locked until reconciled; it must not blindly resubmit.

## Safety boundary

Do not set `ENABLE_MAINNET_AGENT_TRADING` or `MAINNET_AGENT_TRADING_ACK` for this testnet deployment. Keep the application and worker configured for chain ID 97. Do not move to mainnet based on unit tests, a worker heartbeat, a quote, or a submitted UserOperation alone. Require a confirmed testnet transaction and the full negative-path acceptance test first.

The worker is intentionally a separate long-running process. Configure the host to restart it on process failure, alert on missing heartbeats, and run only one instance until the database claim/lease behavior has been verified under concurrency.
