# WOLV Spot Lens

**See the price. Trust the route.** WOLV compares issuer/listed reference data with executable spot quotes for tokenized equities on BNB Smart Chain (BSC), normalizes prices per underlying share, and explains quote freshness and market status before a user chooses whether to trade.

WOLV currently lists Ondo and bStocks assets. It is spot-only, does not execute perps or autonomous trades, and is not investment advice. A displayed spread is not guaranteed profit and does not account for fees, gas, liquidity, slippage, quote age, or execution changes.

## Product routes

| Route | Purpose |
|---|---|
| `/` | Monitor-first view of listed/reference prices versus executable spot quotes |
| `/gap` | Full reference-versus-executable cross-venue monitor with reliability exclusions and market-status context |
| `/markets` | Searchable BSC spot-eligible tokenized-stock directory |
| `/stock/:address` | Asset details, issuer/reference information, real chart data when available, executable quote, and trade entry point |
| `/trade` | Spot-eligible asset selection |
| `/trade/:address` | Wallet-connected quote, real simulation, approval, and user-confirmed trade flow |
| `/wallet` | Read-only BSC holdings and portfolio overview for the connected address |

The product uses live Binance Web3 API data. If an upstream feed is unavailable, malformed, or empty for an unfiltered market list, WOLV must show an unavailable state; it must not substitute sample prices or imply a verified opportunity. A valid category-filter response with no matching assets remains a normal “no matches” state.

## Current integrations and safety boundaries

- **RWA Data API:** token and platform lists, token metadata, issuer profile, market-status fields, and reference-price fields.
- **Trading API:** aggregator spot quotes, swap details, approval data, and RFQ order submission/status where returned by the API.
- **Transaction API:** Binance-signed BSC preflight simulation before wallet prompts. A successful simulation is not an approval, broadcast, or receipt.
- **Wallet execution:** approval and direct SWAP transactions are sent through the connected wallet's normal confirmation flow; receipt status is read from BSC. RFQ execution uses wallet typed-data signing and Binance order status polling.
- **Wallet API:** `/api/wallet/portfolio` and `/wallet` provide a read-only BSC holdings/portfolio view. The page does not sign or execute transactions.

Binance API credentials are server-only. Never expose `BINANCE_API_KEY` or `BINANCE_SECRET_KEY` through a `NEXT_PUBLIC_` variable or commit them. Quote binding, freshness, minimum-order, spot eligibility, router/spender checks, simulation, wallet confirmation, and transaction-status safeguards must remain intact.

**Known operational limitation:** the outbound Binance request queue is process-local; it is not a shared rate limiter across serverless instances. Static official router/spender allowlisting, RFQ signer recovery/replay protection, and refreshed swap calldata immediately before signing remain separate hardening topics documented in [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md). Do not represent them as resolved.

## Local setup

Requirements: a Node.js release supported by Next.js 16 and pnpm.

Create `.env.local` with server-only Binance credentials. A WalletConnect project ID is optional when testing only an injected wallet:

```dotenv
BINANCE_API_KEY=your_web3_api_key
BINANCE_SECRET_KEY=your_web3_api_secret
NEXT_PUBLIC_WALLET_PROJECT_ID=your_walletconnect_project_id
```

Install and run:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The repository's dev/build scripts use webpack. Production build needs network access for `next/font/google`; WalletConnect features require a valid project ID.

## Checks

```sh
pnpm test:logic
pnpm test:hardening
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

For a production-route viewport pass, build and start the app, then in another terminal:

```sh
pnpm start
# separate terminal
pnpm test:responsive
```

The responsive runner requires Chromium (`CHROME_BIN` can point to a non-standard install) and checks `/`, `/gap`, `/markets`, `/trade`, and `/wallet` at 320px, 390px, 768px, and 1440px. Set `TEST_TOKEN_ADDRESS` to exercise `/stock/:address` and `/trade/:address` too; that makes 28 route/viewport cases. Use a current supported asset address for live-data detail states. With unavailable local API credentials, the detail routes should render their explicit feed-unavailable state. These automated checks do not connect a wallet, sign, or broadcast a transaction.

## Hackathon preparation

The main-track project is centered on tokenized stocks on BSC and spot-only trading. Eligibility is the participant's responsibility; the app does not geofence or determine legal eligibility. Re-check the [official hackathon rules](https://www.bnbchain.org/en/hackathons/tokenized-stocks) and current Binance prohibited-region terms.

- [Submission brief and judge journey](./HACKATHON_SUBMISSION_BRIEF.md)
- [Repository readiness audit](./HACKATHON_SUBMISSION_AUDIT.md)
- [Current trading architecture](./TRADING_ARCHITECTURE.md)
- [Developer Experience report draft](./DEVEX_REPORT_2026_SESSION_DRAFT.md) — builder review and firsthand rewrite required; do not submit this draft as-is.

The Developer Experience Report requires specific, honest builder observations and is worth 25% of judging. No AI-generated report can substitute for the builder's own account of onboarding, documentation, support, API behavior, and what they would change. The official overview calls a demo video of four minutes or less strongly recommended but optional; confirm the active submission form and keep any submitted video within that limit.
