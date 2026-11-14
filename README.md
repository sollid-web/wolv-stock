l# WOLV Spot Lens

**See the price. Trust the route.**

WOLV Spot Lens is a BNB Smart Chain (**BSC**) tokenized-stock discovery, price-gap monitoring, and user-authorized spot-trading terminal. It compares issuer/listed reference data with executable quotes, normalizes prices per underlying share, explains quote freshness and market status, and lets a user decide whether to continue into a protected wallet flow.

> A displayed spread is not guaranteed profit. It may reflect fees, gas, liquidity, slippage, quote age, market-session differences, or execution changes.

[![Live application](https://img.shields.io/badge/Live%20application-wolv--stock.vercel.app-FFC700?style=flat&labelColor=0A0D14)](https://wolv.space)
[![BNB Smart Chain](https://img.shields.io/badge/Network-BNB%20Smart%20Chain-F3BA2F?style=flat&labelColor=0A0D14)](https://www.bnbchain.org/en)
[![Main track](https://img.shields.io/badge/Track-Tokenized%20Stocks-FFC700?style=flat&labelColor=0A0D14)](https://www.bnbchain.org/en/hackathons/tokenized-stocks)

- **Live application:** [wolv-stock.vercel.app](https://wolv-stock.vercel.app)
- **Repository:** [github.com/sollid-web/wolv-stock](https://github.com/sollid-web/wolv-stock)
- **Demo video:** [Watch the WOLV walkthrough on YouTube](https://youtu.be/E6QEMJIIAfg?si=Jw3AtuueLI4-Aj2Z)
- **Developer Experience Report:** [DevReport.MD](./DevReport.MD)
- **License:** [MIT](./LICENSE)

## Why WOLV exists

Tokenized-stock users often see a reference price without knowing whether that price is executable for their trade size, through a particular venue, at the current moment. WOLV makes that distinction visible:

- **Reference price:** issuer/listed or underlying-share reference data.
- **Executable price:** what the selected route currently quotes for the requested trade size.
- **Gap:** a normalized comparison, not a promise of arbitrage.
- **Context:** quote age, venue, execution mode, price impact, market status, token/share ratio, and reliability checks.

The product is designed for Web2 users who need a clear explanation before they encounter wallet approval and transaction confirmation.

## Current live deployment

The following screenshots were captured from the live application on **9 October 2026** after verifying the current upstream commit and successful Vercel deployment:

- Repository commit: [`d41731d`](https://github.com/sollid-web/wolv-stock/commit/d41731d73fdf9d8c7815b8dbbc9527bfc66a534a)
- Vercel deployment: [completed successfully](https://vercel.com/ozoani/wolv-stock/2hLzFWePkuFrpHWvMiAXBWTUZKba)

### Homepage and WOLV AI entry point

![Current WOLV Spot Lens homepage showing the executable-price monitor, market-status context, and WOLV AI entry point](./docs/screenshots/wolv-live-home.webp)

### Cross-venue gap monitor

![Current WOLV gap monitor showing normalized executable prices, venue status, and session-mismatch warnings](./docs/screenshots/wolv-live-gap.webp)

### User-controlled trade route

![Current WOLV trade route showing the BSC Smart Router, spot-only guard, venue comparison, and wallet connection step](./docs/screenshots/wolv-live-trade.webp)

## What is implemented

### Market discovery and analysis

- Browse spot-eligible tokenized equities on BSC.
- Explore asset details, issuer information, market status, and reference data.
- Compare supported representations across venues such as **Ondo** and **bStocks**, where available.
- Use the `/gap` monitor to compare reference-backed executable quotes across venues.
- Exclude stale, malformed, missing-reference, and extreme outlier comparisons from reliable rankings.
- Surface market-session mismatches instead of presenting them as clean trading opportunities.
- Open WOLV AI market analysis for a grounded, plain-English explanation of the displayed data.

### Protected spot trading

- Request a fresh quote for a supported asset and trade amount.
- Enforce the Binance minimum order requirement at the application boundary.
- Validate spot eligibility, addresses, amounts, chain, quote freshness, and quote binding.
- Prepare swap or RFQ flows according to the returned execution mode.
- Simulate supported transactions before wallet approval.
- Revalidate the prepared transaction and run the applicable preflight before wallet approval/signing; the current normal `SWAP` path reuses the prepared calldata from `/api/swap` rather than fetching a new payload immediately before signing.
- Ask the connected wallet to approve and broadcast; WOLV does not custody private keys.
- Show wallet-prompt, submitted, pending, confirmed, failed, and user-rejected states.
- Read the BSC receipt and expose transaction evidence for verification.

### Read-only portfolio view

`/wallet` provides a read-only holdings and portfolio surface for the connected address. It does not sign, approve, or execute transactions.

### Agent strategy preview

`/agent` retains a local mock strategy preview, but the owner-authorized policy panel now supports a separate persistent BSC autonomous-trading path. The owner configures a strategy mandate once, then signs one browser-session challenge to persist it as an `AUTONOMOUS` schedule. The long-running worker evaluates the schedule without asking for wallet approval on each trade. The ZeroDev integration uses a delegated session signer with a seven-day permission window, public bundler configuration, and a WBNB-to-configured-token route builder. That builder reads PancakeSwap V2 reserves, calculates fee-adjusted output and a slippage minimum, and rejects quotes above its configured price-impact ceiling. This spot-impact check is not a historical volatility oracle. The on-chain hook binds the target token during installation and enforces the route, recipient, minimum output, selector, and volume caps. Account revocation is owner-controlled; the guardian can pause all accounts.

The `/agent` page also exposes owner-authorized Kernel policy setup, on-chain policy status, and revocation on BSC mainnet or testnet. Policy hashes use the versioned `WOLV_AGENT_POLICY_V4` encoding and bind the authenticated owner wallet, exact smart-account address, strategy ID, target token, maximum trade value, expiry, delegated intent signer, strategy amount, entry-price threshold, maximum slippage, and maximum price impact. The worker recomputes this hash from the live on-chain policy before creating an intent; an unknown or renamed strategy fails closed. Existing pre-V4 policies must be reconfigured by the owner before the updated worker can execute. A connected owner wallet and the matching public RPC are sufficient to derive and display the smart-account address; loading policy state also requires the deployed hook, while policy changes additionally require the matching bundler. Kernel UserOperation EIP-1559 fees are estimated through the configured public RPC so compatible third-party bundlers do not need to implement ZeroDev-specific gas-price methods. Hook installation and policy configuration are separate single-call UserOperations; the UI waits for each receipt and verifies the resulting hook and policy state. Configure `NEXT_PUBLIC_POLICY_HOOK_ADDRESS` with the deployed validator, `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS` with the authorized token, `NEXT_PUBLIC_AGENT_SIGNER_ADDRESS` with the delegated intent signer, and `NEXT_PUBLIC_CHAIN_ID` as `56` (mainnet) or `97` (testnet). Also configure the matching public RPC and bundler URLs (`NEXT_PUBLIC_BSC_RPC_URL` / `NEXT_PUBLIC_BSC_BUNDLER_RPC_URL` or `NEXT_PUBLIC_BSC_TESTNET_RPC_URL` / `NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL`). Bundler URL query parameters are accepted, but these `NEXT_PUBLIC_` values are browser-visible; do not put secrets in them. After the policy receipt is verified, a one-time BAW browser-wallet session signature persists the exact strategy as a `BSC_AGENT_TRADE` schedule. This schedule-management session requires `BAW_WALLET_API_TOKEN` and `BAW_BROWSER_WALLET_ALLOWLIST` on the server; it is not a per-trade approval. The UI can pause or resume that schedule; pausing stops future cycles but cannot cancel a UserOperation already submitted or reverse a confirmed trade. On-chain pause and revocation remain independent emergency controls. Binance-backed spot trading remains mainnet-only.

The standalone [`AgentWorker`](./services/agentWorker.ts) evaluates configured price thresholds on an interval, reads the validator’s effective (unexpired) rolling volume and pause/revocation state, recomputes the owner- and owner- and account-bound V4 policy hash from the exact strategy ID and all execution-relevant strategy parameters, and emits structured pass/fail telemetry. It refuses unknown, renamed, or otherwise mismatched strategy identities before intent creation. It creates a bounded execution intent only after all preflight checks pass, prevents duplicate pending intents, and panic-stops with a high-priority alert after repeated policy/RPC failures. [`AgentExecutor`](./services/agentExecutor.ts) provides the UserOperation dispatcher: it revalidates the intent and validator state, requotes the route, allocates a persistent atomic Redis nonce per smart account, signs through the supplied owner-validator/delegated-signer authorization, submits through the configured ZeroDev bundler client, and polls the receipt. Nonces are never reset or reused, including when a signature or UserOperation later fails.

Run the persistent process with `npm run agent:worker`. The command loads `.env`, `.env.local`, and optional `.env.worker`; `.env.worker` may use `CHAIN_ID` and, on testnet, `RPC_URL`, which are mapped to the smart-account configuration when its corresponding `NEXT_PUBLIC_` values are absent. It requires `WOLV_AGENT_DATABASE_URL` (or `WOLV_TRADING_DATABASE_URL`) for persistent schedules, `AGENT_PRIVATE_KEY` as a dedicated delegated intent signer (never an owner-wallet key), Redis, and the usual server-side account/RPC/bundler configuration. The worker derives the owner's ECDSA validator from the schedule's public owner address using an address-only signer; `AGENT_OWNER_VALIDATOR_MODULE` is an optional override. No owner private key is required by the worker. Market data defaults to the guardian-allowlisted Chainlink USD feed and PancakeSwap V2 pool reserves; `AGENT_MARKET_DATA_MODULE` is an optional override. In persistent mode it polls PostgreSQL every five seconds, records a worker heartbeat, atomically claims due `BSC_AGENT_TRADE` schedules, and evaluates each schedule at its configured interval (the UI defaults to 60 seconds). The policy panel reports a worker as running only while a heartbeat for the configured chain has been seen within the last 20 seconds. A schedule with an unresolved `CLAIMED` or `SUBMITTED` execution claim is not claimed again; uncertain post-submission failures disable the schedule until the execution is reconciled. Rescheduling occurs after a cycle completes, preventing long receipt waits from triggering immediate back-to-back cycles. Each strategy `id`, account, amount, entry-price threshold, slippage, and price-impact limit must exactly match the owner- and account-bound V4 policy authorized on-chain. The on-chain policy must authorize that signer. A custom market-data adapter, when configured, must export `fetchMarketData(strategy, { config, client })` and return a `MarketSnapshot`. Security boundary: the V4 commitment prevents schedule/config drift and is checked by both the worker and executor. The V2 validator stores the owner-configured entry-price ceiling, maximum slippage, and maximum price-impact values and independently checks them during hook pre-execution. It requires fresh, positive Chainlink BNB/USD and allowlisted target-token/USD feeds; missing, stale, future-dated, invalid, or revoked feeds fail closed. The oracle-derived target-token price is checked against the entry ceiling, and the router's minimum output is checked against a conservatively rounded oracle-derived output floor using the stricter signed and stored risk limits. The V2 hook is a separate deployment: accounts must install it and configure a new policy before autonomous execution. Do not enable mainnet execution until the V2 contract, feed addresses, delegated signer, worker adapters, and full test suite have been independently verified.

An optional owner-validator override must export `getOwnerValidator(account, config, ownerAddress)` and return a compatible `KernelValidator`. By default, the worker derives the ECDSA owner validator from the public owner address using ZeroDev's address-only signer support; the owner's private key is not needed for unattended session-key execution. The 15-second quote-age limit is measured from local market-data receipt and is enforced again by the executor before dispatch. Both `WOLV_AUTONOMOUS_TRADING_ENABLED=true` and `ENABLE_LIVE_USEROP_SUBMISSION=true` are required before the worker claims schedules or submits. Mainnet additionally requires `ENABLE_MAINNET_AGENT_TRADING=true` and `MAINNET_AGENT_TRADING_ACK=I_ACCEPT_AUTONOMOUS_MAINNET_RISK`. All gates remain off by default. If no database URL is configured, the worker retains `AGENT_STRATEGIES_JSON` as a static development fallback.

The authenticated `/api/agent/simulation` endpoint and Agent terminal perform read-only BSC testnet transaction simulation for the configured router and target token. They check the calldata route, wallet balance, estimated gas, and EVM call result; they never request a signature or broadcast a transaction. The separate BAW/terminal session-plan workflow binds a single configured router/token scope and explicitly requires human approval and successful simulation; those plans remain `not-granted` and are distinct from the V4 `/agent` autonomous BSC strategy path. The server-generated ephemeral session-key helper has been removed; the simulation workflow itself never broadcasts a transaction.

Durable agent policies also cap proposal generation to 1–12 proposals per hour. The proposal transaction rechecks the active policy, permission expiry, global emergency stop, and hourly cap while holding database locks, so concurrent runs cannot bypass those checks. This is a proposal-frequency limit, not a trade-execution quota; signing and submission remain disabled.

The executor does not request owner approval per trade. It constructs a scoped Kernel session validator from `AGENT_PRIVATE_KEY`, with a call policy limited to the configured router, swap selector, and hard trade value; the on-chain hook applies the account-specific policy. `AGENT_OWNER_VALIDATOR_MODULE` must provide the owner validator used to construct the Kernel account. Protect the delegated signer key as a production secret and use the on-chain revoke/pause controls for emergency shutdown. Bundler errors, receipt timeouts, and on-chain reverts are structured and can feed `worker.reportExecutionFailure()` through `createWorkerFailureReporter()`. Mock tests cover dispatch and receipts. No testnet or mainnet UserOperation has been submitted from this development session. The `/agent` BSC strategy path now persists schedules and the worker can claim them, but the long-running worker still must be deployed with production market-data, owner-validator, database, Redis, and execution-gate configuration; production alerting/monitoring remains an operational task.

The validator emits attempt/success events for executions that reach successful transaction completion. Logs in a reverted transaction are rolled back; the TypeScript execution helper records structured local attempt, submit, success, and rejection records. The guardian is the validator deployer (`msg.sender`) and can pause all accounts; account policy changes and revocation require the smart account itself. The `/agent` policy panel now persists account-bound autonomous BSC schedules and the worker/executor revalidate the V4 commitment before dispatch. ERC-8004 registration, ERC-8183 jobs, and x402 settlement remain unavailable.

## Product routes

| Route | Purpose |
|---|---|
| `/` | Data-led homepage with executable-price comparison, freshness/session context, WOLV AI entry points, and opportunity discovery |
| `/agent` | Owner-authorized on-chain policy setup/status/revocation, persistent autonomous BSC strategy registration, schedule pause/resume, and agent capability telemetry; the separate local strategy preview remains mock-only |
| `/gap` | Reference-versus-executable cross-venue monitor with reliability exclusions and market-status context |
| `/markets` | Searchable BSC spot-eligible tokenized-stock directory |
| `/stock/:address` | Asset detail, issuer/reference information, chart data when available, executable quote, and trade entry |
| `/trade` | Spot-eligible asset selection |
| `/trade/:address` | Quote, simulation, approval, and user-confirmed spot-trade flow |
| `/wallet` | Read-only BSC holdings and portfolio overview |

If an upstream feed is unavailable, malformed, or empty when an unfiltered market list is expected, WOLV shows an explicit unavailable state. It does not substitute sample prices or imply a verified opportunity.

## Trading flow

```text
Select asset
   ↓
Request fresh quote
   ↓
Validate spot eligibility, amount, freshness, and quote binding
   ↓
Prepare swap/RFQ transaction
   ↓
Simulate where supported
   ↓
Refresh calldata immediately before signing
   ↓
User reviews and confirms in their wallet
   ↓
Wallet broadcasts on BSC
   ↓
WOLV reads receipt/status and links to on-chain evidence
```

A successful simulation is **not** an approval, broadcast, or confirmed transaction. A quote ID is also not automatically an order ID; direct on-chain swaps and off-chain RFQ order workflows have different status semantics.

## Architecture and safety boundaries

- **RWA Data API:** token/platform lists, metadata, issuer profiles, reference prices, and market-status fields.
- **Trading API:** aggregator quotes, swap details, approval data, and RFQ order submission/status where returned.
- **Transaction API:** Binance-signed BSC simulation before wallet prompts.
- **Wallet execution:** approval and direct SWAP transactions use the connected wallet’s normal confirmation flow; RFQ execution uses wallet typed-data signing and Binance order status polling.
- **Wallet API:** read-only BSC balances and portfolio overview.
- **Server-only credentials:** `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` are read by server-side code and must never be exposed through `NEXT_PUBLIC_` variables.
- **Quote protection:** freshness checks, minimum-order validation, quote binding, address validation, spot filtering, and simulation gates remain part of the trade boundary.

### Important limitations

The following are not represented as fully solved:

- The outbound Binance request queue is process-local, not a distributed rate limiter.
- Static official router/spender allowlisting remains a separate hardening topic and must be verified against current official contract data before public mainnet use.
- Immediate pre-signing swap-calldata refresh remains a separate hardening item for the normal `SWAP` path.
- WOLV does not independently recover the signer for Binance-supplied RFQ typed data.
- The BNB Agent SDK and Binance agentic-wallet skill are installed for separate integrations; live Altana/TWAK session providers, ERC-8004 registration, ERC-8183 job lifecycle, and x402 settlement are not enabled. The autonomous BSC agent path is separate from Binance-backed spot trading and uses a delegated Kernel session key, Chainlink USD feeds, and PancakeSwap V2 pool reserves.
- `BNB_AGENT_KEY` is intentionally unused. Do not configure a server-wide private key; live agent execution needs per-user session authorization, bounded permissions, and a durable worker.
- The app does not geofence or determine legal eligibility; users and participants must review current official terms and applicable laws.

## Verified BNB Smart Chain mainnet execution evidence

The final developer report records three **actual BNB Smart Chain mainnet transactions** and their limitations. Each BscScan link below points to a mainnet transaction record, not a testnet or simulated result:

| Evidence | Transaction | What it demonstrates |
|---|---|---|
| Sunday off-hours trade | [`0x5f9955…c68855`](https://bscscan.com/tx/0x5f995506ecf2b4f5e407414bcf379f4f34bf538040e0e3e9ca92040b80c68855) | Successful `NVDAon` execution on October 4, 2026 at 22:52:59 UTC; BscScan displayed an internal execution-reverted warning despite overall success |
| Weekday demo trade | [`0x3bd762…60367`](https://bscscan.com/tx/0x3bd762832f273a1553341f935c02533e1aca0107730cac62af2e66ec94860367) | Successful `NVDAB` execution shown in the demo evidence |
| Earlier NVDAB trade | [`0x93d347…638e9`](https://bscscan.com/tx/0x93d34764fd6d7b3be7662e283b5357e4ab086e2b286596f97989b49d0e8638e9) | Successful execution and evidence that raw BEP-20 and UI transfer amount fields can differ |

These BNB Smart Chain mainnet records demonstrate actual execution evidence, not guaranteed liquidity or continuous availability for every tokenized stock. A simulation or quote alone is not counted as execution evidence.

## Demonstration

The final report documents the recorded walkthrough:

[Watch the WOLV demonstration](https://youtu.be/E6QEMJIIAfg?si=Jw3AtuueLI4-Aj2Z)

The walkthrough covers:

1. Tokenized-stock discovery through `/markets`.
2. NVIDIA selection and reference-price-gap presentation.
3. Visible handling of an execution-reverted error.
4. Retrieval of a fresh executable quote.
5. MetaMask confirmation and user-authorized BSC execution.
6. Transaction confirmation and independent BscScan verification.

For submission, the transaction hash displayed in the recording should be included alongside the relevant explorer link so judges can independently inspect status, transfers, contracts, and amounts.

## Technology stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- Wagmi / Viem
- Recharts and Lightweight Charts where used by the current UI
- Binance Web3 RWA, Trading, Transaction, Wallet, and Portfolio APIs
- BNB Smart Chain
- Vercel

## Local development

### Requirements

- Node.js supported by Next.js 16
- pnpm
- Binance Web3 API credentials for live server routes
- An injected EVM wallet or WalletConnect project ID for wallet testing

### Configure environment variables

Create `.env.local` with server-only credentials:

```dotenv
BINANCE_API_KEY=your_web3_api_key
BINANCE_SECRET_KEY=your_web3_api_secret

# Optional server-only BSC RPC endpoint; use for authenticated/private RPC access.
BSC_RPC_URL=

# Optional read-only metadata-audit cross-check. Distinct operator labels are
# required and are operator-asserted; different URLs alone do not prove independence.
BSC_RPC_OPERATOR=
BSC_RPC_SECONDARY_URL=
BSC_RPC_SECONDARY_OPERATOR=

# Optional server-only archive endpoint for a separately confirmed, read-only
# historical-state probe. Successful reads at the pinned block establish capability.
BSC_RPC_ARCHIVE_URL=
BSC_RPC_ARCHIVE_OPERATOR=
BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED=

# Optional browser-visible public BSC RPC endpoint. Must not contain URL credentials,
# path tokens, query parameters, or fragments; defaults to a public BSC RPC.
NEXT_PUBLIC_BSC_RPC_URL=https://bsc-dataseed.binance.org/

# Optional when using WalletConnect; injected wallets can be tested without it
NEXT_PUBLIC_WALLET_PROJECT_ID=your_walletconnect_project_id

# Optional server-side WOLV AI explanation layer
WOLV_AI_API_KEY=your_openai_compatible_key
WOLV_AI_BASE_URL=https://api.openai.com/v1
WOLV_AI_MODEL=gpt-5-mini
```

The archive probe defaults to a no-network dry run:

```bash
node --conditions=react-server --experimental-strip-types scripts/bsc-archive-probe.mjs
```

It compares the three fixed Phase 3.15 targets at the primary endpoint's pinned
latest block and original audit block. If `BSC_RPC_ARCHIVE_URL` is configured,
it also reads those targets at the original block. Live reads require
`--live-read-only` and the exact interactive confirmation
`READ-ONLY ARCHIVE STATE PROBE`. Archive capability is determined from those
read results, not from provider marketing. Distinct operator labels are
assertions and do not independently prove provider ownership. Cross-provider
classification additionally requires the explicit operator attestation value
`I_CONFIRM_SEPARATE_OPERATORS` in `BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED`.
To authorize only the primary endpoint's current-versus-historical comparison,
use `--live-read-only --primary-only`; this explicitly excludes any configured
archive URL from that run.

Never commit `.env.local`, private keys, wallet seed phrases, or API secrets.
`BNB_AGENT_KEY` is not read by this wallet-confirmation build and must not be used as a shared server trading key. See [.env.example](./.env.example) for the complete variable template.

The Binance agentic-wallet skill is available at `.agents/skills/binance-agentic-wallet`; it was added with:

```bash
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

### Install and run

```bash
git clone https://github.com/sollid-web/wolv-stock.git
cd wolv-stock
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

The development and production build scripts use Turbopack for faster compilation. WalletConnect/AppKit providers are scoped to the agent, wallet, and trade-detail routes, keeping the initial homepage and market-list compilation lighter. The app uses system-font fallbacks, so production compilation does not need a Google Fonts network request.

## Checks

```bash
pnpm test:logic
pnpm test:hardening
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

The responsive command builds and starts its own production server, waits for an HTTP health response, runs Chromium at the supported viewport widths, blocks quote/approval/execution endpoints, and shuts down both server and browser:

```bash
pnpm test:responsive
```

The responsive runner checks `/`, `/gap`, `/markets`, `/trade`, `/wallet`, and `/agent` at 320, 360, 390, 414, 768, 1024, and 1440 pixels. Set `TEST_TOKEN_ADDRESS` to include `/stock/:address` and `/trade/:address` detail cases. These checks do not connect a wallet, sign, or broadcast a transaction.

PostgreSQL integration tests require an explicitly configured local disposable test database. For example, start a temporary container and read its assigned loopback port:

```bash
docker run --rm --name wolv-test-postgres \
  -e POSTGRES_DB=wolv_phase38_test \
  -e POSTGRES_USER=wolv_test \
  -e POSTGRES_PASSWORD=local-test-only \
  -p 127.0.0.1::5432 -d postgres:16-alpine
PG_PORT="$(docker port wolv-test-postgres 5432/tcp | sed 's/.*://')"
trap 'docker stop wolv-test-postgres' EXIT
TEST_POSTGRES_URL="postgresql://wolv_test:local-test-only@127.0.0.1:${PG_PORT}/wolv_phase38_test" pnpm test:postgres
```

`TEST_POSTGRES_URL` must point to a loopback host and a database name containing `test` or `testing`. The integration test refuses production-style database URLs and cleans up its test tables.

## Developer documentation

- [Developer Experience Report](./DevReport.MD) — final builder report covering onboarding, authentication, API pitfalls, wallet behavior, tokenized-stock findings, evidence, and platform recommendations.
- [Trading Architecture](./TRADING_ARCHITECTURE.md) — current request flow, signing boundaries, route behavior, and remaining hardening topics.
- [WOLV Spot Lens handoff](./WOLV-SPOT-LENS-HANDOFF.md) — project context and continuation notes, when present locally.

## BNB Chain hackathon scope

WOLV is focused on the main tokenized-stocks track:

- BNB Smart Chain mainnet
- Spot tokenized-equity discovery and trading
- User-authorized, non-custodial wallet execution
- Clear distinction between reference prices and executable quotes
- No perpetuals
- Owner-authorized autonomous BSC spot-agent execution through a delegated session key and on-chain policy validator; execution remains disabled until configured and verified

Eligibility, restricted-region rules, and submission requirements are the participant’s responsibility. Review the [official hackathon rules](https://www.bnbchain.org/en/hackathons/tokenized-stocks) and current Binance terms before submission.

## Risks and disclaimer

Tokenized stocks are blockchain-based products whose availability, pricing, redemption rights, restrictions, and risks depend on their respective issuers and platforms. Reference prices do not guarantee executable prices. Liquidity, slippage, trading restrictions, gas, network conditions, market hours, and quote changes may affect execution.

WOLV is a software interface, not a guarantee of liquidity, price parity, investment returns, legal eligibility, or transaction success. This project is provided for demonstration and informational purposes. Users are responsible for independently evaluating tokenized-stock products, wallet prompts, transaction details, and applicable restrictions.

## License

The application source is released under the [MIT License](./LICENSE). The disclaimer above remains applicable to the project and its use with tokenized-stock products.
