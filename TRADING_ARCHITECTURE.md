# WOLV Spot Lens: Current Architecture

## Product Scope

The main-track product is a BSC spot cross-venue monitor for tokenized equities. It compares Binance RWA issuer/reference fields with current aggregator quotes for Ondo and bStocks, then offers a user-approved spot trade. It does not run perps or autonomous execution.

## Implemented Request Flow

1. Server-rendered pages use the RWA Data API for token/platform lists, categories, metadata, and issuer profiles.
2. The gap view calls the aggregator quote endpoint for the candidate token addresses and compares executable prices with the listed reference fields.
3. The browser requests a quote from `/api/quote`, then transaction details from `/api/swap`. Both API routes validate address/amount formats and verify the target is in the cached RWA list and passes the spot-only metadata filter.
4. For `SWAP` responses, the server validates the transaction payload and runs Binance Transaction API simulation through `/api/transaction-simulate`. The UI shows predicted balance/allowance changes. The browser repeats simulation immediately before prompting the connected wallet to approve/send on BSC mainnet.
5. For `RFQ` responses, the browser signs the returned EIP-712 data and posts the signature, vendor, quote ID, idempotency UUID, and selected target address to `/api/order/submit`. The server rechecks spot eligibility before Binance receives the order submission. Status is polled through `/api/order/[orderId]`.
6. Approval and order-status requests use no-store fetches. Catalog requests use a 60-second cache. Outbound Binance requests are serialized at a 250 ms minimum interval per server process.

## Credential And Signing Boundaries

- `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` are read in server-side `lib/binance.ts`; do not expose either through a `NEXT_PUBLIC_` variable.
- Wallet transaction signing and EIP-712 signing happen through the connected wallet in the browser. Private keys are not sent to the app server.
- The order-submit route validates request shape and forwards the signature to Binance. It does **not** independently recover or verify the signer locally.
- The current transaction destination is supplied by the upstream swap response. The app checks its address shape and simulates the call, but does not maintain an allowlist of Binance router contracts. Confirm official router destinations before treating this as a production custody/security review.

## Spot Eligibility And Regional Rules

Listings, detail pages, trade pages, quote, swap, and approval request entry points share a conservative spot-only filter. It excludes a short known ticker blacklist, explicit leverage fields, and leveraged/inverse descriptions. This is a product filter, **not** issuer approval, a complete security classification, legal advice, or a substitute for reviewing each current API record.

The hackathon and Binance Web3 developer product have restricted-region and sanctions eligibility rules. The UI links the official prohibited-region list but does not geofence or determine eligibility. Participants and users must review current official terms and their applicable laws.

## Explicitly Not Integrated

- Binance Transaction API broadcasting: simulation is integrated; transaction broadcast remains with the user's connected wallet. The app does not use Binance's optional broadcast endpoint.
- Binance Wallet/Address Portfolio API, Agentic Wallet/Wallet Skills, and BNB Agent Studio.
- Distributed per-client API rate limiting. The current Binance request queue is process-local and is not sufficient by itself for a horizontally scaled public deployment.
- Automated local EIP-712 signer recovery and persistent replay tracking. Binance remains the external order-submission boundary.

## Before Public Mainnet Use

Verify the complete supported-token metadata against the official spot-only track requirement; validate aggregator router and spender destinations against current official contract data before allowlisting; configure persistent edge/API rate limits and monitoring; test quote expiry, account/chain switching, approval and reverted transactions with small amounts; and run the production build and browser wallet tests on the deployment target.