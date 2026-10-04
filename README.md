
# WOLV Spot Lens

WOLV Spot Lens compares executable spot quotes for tokenized equities across BSC venues with issuer reference data. It is built for the BNB Hack: Tokenized Stocks Edition main track, targeting the event's cross-protocol price-dislocation and on-chain-vs-reference monitor ideas. Users can inspect a spread and, if they choose, continue into a wallet-approved spot trade on BSC mainnet.

The project currently lists Ondo and bStocks assets. It does not execute perps, run an autonomous trading agent, or provide investment advice. Prices and liquidity can change between quote, simulation, and wallet confirmation.

## Current Integration

- **RWA Data API:** token/platform lists, sector filtering, token metadata, issuer profile, and reference-price fields.
- **Trading API:** aggregator quotes, transaction details, approval transaction data, and order submission/status where returned by the API.
- **Transaction API:** Binance-signed BSC transaction simulation before wallet approval/swap prompts; the UI uses simulation allowance changes to check USDT authorization and shows predicted balance changes.
- **Wallet execution:** Approval and SWAP transactions are submitted through the connected wallet's standard transaction-confirmation flow. The wallet signs and broadcasts them to BSC; WOLV checks receipts through its BSC RPC client.
- **Wallet API:** Binance transaction-detail queries remain available for Binance-backed transaction and RFQ order status.
- **Not yet integrated:** portfolio API, Agentic Wallet/Wallet Skills, and BNB Agent Studio.

Trade-related API requests use uncached fetches. Binance credentials are read only by server-side code. Never put `BINANCE_API_KEY` or `BINANCE_SECRET_KEY` in a `NEXT_PUBLIC_` variable or commit them.

## Run Locally

Requirements: Node.js supported by Next.js 16 and pnpm.

Create `.env.local` with server-only credentials and a WalletConnect project ID if that connector is required:

```dotenv
BINANCE_API_KEY=your_web3_api_key
BINANCE_SECRET_KEY=your_web3_api_secret
NEXT_PUBLIC_WALLET_PROJECT_ID=your_walletconnect_project_id
```

Then run:

```sh
pnpm install
pnpm dev
```

The dev script uses webpack for this environment. Production also requires the Binance credentials and a valid WalletConnect project ID if WalletConnect is enabled.

## Hackathon Scope And Submission

The official main-track rules require a central bStocks, Ondo, or xStocks use case, spot-only trading, and BSC mainnet. This project targets cross-venue spot price discovery for Ondo and bStocks. Verify each supported instrument is spot-eligible before submission and before enabling trade routes.

The event also restricts participation and Binance Web3 developer-product access by location, residence/citizenship, and sanctions status. See the [official event eligibility rules](https://www.bnbchain.org/en/hackathons/tokenized-stocks?tab=overview) and [Binance prohibited regions](https://web3.binance.com/en/dev-docs/web3-api-prohibited-regions). This app does not geofence or determine legal eligibility; participants and users must check current rules themselves.

Submissions need a public repository and a working deployed link or reproducible instructions. A demo video of four minutes or less is strongly recommended. The Developer Experience Report is worth 25% of the score and must contain specific firsthand observations; `DEVEX_LOG.md` is raw working evidence, not a completed report. The event explicitly rejects perfunctory or AI-generated reports, so prepare that deliverable from the builder's own experience using the [official template](https://forms.gle/EUQ39xf54GHjC2ys5).

The optional Agentic Wallet/Wallet Skills and BNB Agent Studio special prizes are not claimed by this implementation.

## Checks

```sh
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

The build uses `next/font/google`, so its build environment must be able to fetch Google Fonts. Only demo live trades with amounts you can afford to lose.

## References

- [Hackathon tracks and judging](https://www.bnbchain.org/en/hackathons/tokenized-stocks?tab=tracks)
- [Binance Web3 API authentication](https://web3.binance.com/en/dev-docs/authentication)
- [RWA Data API](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data)
- [Trading API](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api)
- [Transaction API](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/transaction-api)

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
