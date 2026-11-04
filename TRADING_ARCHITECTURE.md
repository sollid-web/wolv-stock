# WOLV Spot Lens: Current Architecture

## Dynamic Strategy Switching

WOLV has an initial dynamic-state evaluator in `lib/dynamicStrategy.ts` and an authenticated
`POST /api/agent/dynamic` endpoint. The evaluator supports two modes:

- `PEAK_DEFENSE` for verified US regular-session time, with 30-bps profile slippage and a 0.5-BNB order cap.
- `OFF_HOURS_ALPHA` for closed-session periods, with a 100-bps hard-capped profile and monitoring-only behavior.

The evaluator rejects stale, future, missing, unrealistic, or contradictory liquidity metrics. It also
rejects peak-session volatility above 300 bps and peak-session liquidity collapse below the normal baseline.
The current implementation never invents liquidity, gas, ATR, timestamps, oracle data, or exchange status;
callers must supply the metrics, and execution remains `false` in the returned evidence.

The `/agent` control plane displays the evaluated mode, liquidity change, profile, warnings, refusal reasons,
and transaction receipt boundary as an execution-reasoning feed. It does not submit a transaction, set an
on-chain mode, sign a message, broadcast a swap, or start a background worker.

Live dynamic cycles can be requested with `POST /api/agent/dynamic { "source": "live" }`. The provider reads
gas from the configured BSC RPC, total USDT-side liquidity from a configured PancakeSwap USDT pair, and
ATR from the Binance Web3 1-hour candle endpoint. It requires a verified liquidity baseline from the most
recent persisted cycle for that owner, or an explicit `WOLV_DYNAMIC_LIQUIDITY_BASELINE_USD` fallback. Missing
provider configuration, stale metrics, unavailable baselines, or malformed provider data fail closed. Cycle
evidence is owner-scoped in PostgreSQL and replayable through `GET /api/agent/dynamic`; it remains
`executionEnabled: false`, and the current US-session approximation does not claim verified exchange-holiday
or half-day coverage.

Live runs use owner-scoped idempotency and a PostgreSQL run lifecycle. A live request creates a
`RUNNING` run once per authenticated owner per minute, rejects duplicates, recovers stale running records,
and transitions the run to `COMPLETED` or `FAILED`. Terminal run records are immutable. The UI exposes
cycle and run history, while no external scheduler or automatic trade worker is started by this endpoint.

## Product Scope

The main-track product is a BSC spot cross-venue monitor for tokenized equities. It compares Binance RWA issuer/reference fields with current aggregator quotes for Ondo and bStocks, then offers a user-approved spot trade. The `/agent` surface adds local strategy drafts and mock trigger evaluation; it does not run perps or autonomous execution.

## Implemented Request Flow

1. Server-rendered pages use the RWA Data API for token/platform lists, categories, metadata, and issuer profiles.
2. The gap view calls the aggregator quote endpoint for the candidate token addresses and compares executable prices with the listed reference fields.
3. The browser requests a quote from `/api/quote`, then transaction details from `/api/swap`. Both API routes validate address/amount formats and verify the target is in the cached RWA list and passes the spot-only metadata filter.
4. For `SWAP` responses, the server validates the transaction payload and the browser runs Binance Transaction API simulation through `/api/transaction-simulate`. The UI uses simulation allowance changes to decide whether USDT approval is needed and shows predicted balance changes. Immediately before an approval, the browser simulates the approval transaction again, then asks the connected wallet to confirm and broadcast it. For the normal swap, the app reuses the prepared `/api/swap` calldata when the earlier simulation succeeded; it simulates again only when that preflight is missing or unsuccessful, then asks the wallet to confirm and broadcast. The current normal `SWAP` path does not fetch refreshed swap calldata immediately before signing. The app reads the resulting receipt from its BSC RPC client.
5. For `RFQ` responses, the browser signs the returned EIP-712 data and posts the signature, vendor, quote ID, idempotency UUID, and selected target address to `/api/order/submit`. The server rechecks spot eligibility before Binance receives the order submission. Status is polled through `/api/order/[orderId]`.
6. Approval and order-status requests use no-store fetches. BSC approval and swap status are polled through `/api/transaction-status`, backed by Binance Wallet API transaction details. Catalog requests use a 60-second cache. Outbound Binance requests are serialized at a 250 ms minimum interval per server process.
7. `/api/wallet/portfolio` retrieves read-only BSC token balances and portfolio overview data for the connected address; `/wallet` renders loading, empty, error, holdings, and portfolio-statistic states. This path does not sign or execute transactions.

## Agent Terminal Boundary

- `/agent` accepts constrained strategy text or structured parameters through `/api/agent/execute`. The endpoint validates a draft or evaluates explicitly supplied mock prices; it does not persist rules, poll markets, schedule jobs, sign transactions, or broadcast swaps.
- `/agent` exposes a separately authenticated BAW quote and explicitly approved execution flow. `POST /api/agent/quote` validates a connected BAW wallet on BNB Smart Chain mainnet and a WOLV spot-eligible token with an open market session. BUY maps USDT to the selected token; SELL maps the selected token to USDT. It passes human-readable quantities and capped explicit slippage to `baw market-order quote`, validates the schema and WOLV quote thresholds, then binds the quote parameters, wallet and expiry. A quote binding is not execution approval.
- `/agent` authenticates only browser wallet addresses listed in the server-only `BAW_AUTHORIZED_BROWSER_WALLETS` allowlist. Challenges are random, short-lived, and single-use; session cookies are HttpOnly, Secure in production, SameSite Strict, database-backed, and revocable. The browser wallet remains distinct from the BAW operator wallet. The server-only `BAW_WALLET_API_TOKEN` is a trusted API bearer secret, not a Binance credential, and is never sent to browser code.
- `POST /api/agent/approve` rechecks the quote, wallet, session, balances, market and configured limits, then creates a short-lived, single-use approval record. `POST /api/agent/execute` requires a separate final user action, the session, approval token and execution ID. It consumes the token atomically, repeats the WOLV and wallet checks, and can call only the validated BAW swap command. Browser-wallet signing and the ZeroDev transaction path are unchanged.
- BAW approvals, execution records, single-use challenges, and revocable sessions use a versioned PostgreSQL schema through the server-only `BAW_EXECUTION_DATABASE_URL`. Approval consumption is transactional, execution IDs are primary keys, and a partial unique index enforces one active execution across instances. Filesystem SQLite is not a production fallback. The app still refuses Vercel serverless BAW execution because the BAW CLI/operator session is not available there. `BAW_EXECUTION_ENABLED` must be `true`, `BAW_EXECUTION_KILL_SWITCH` must be `false`, PostgreSQL and conservative per-order/daily/slippage/BNB-reserve limits must be configured (hard caps: $1,000/order, $5,000/day, 100 bps slippage, minimum 0.01 BNB reserve), and the authenticated operator wallet must pass its live preflight. Defaults remain disabled.
- Submission uses only the documented forms `baw market-order swap --fromTokenQty <human-readable amount> --fromToken <address> --toToken <address> --binanceChainId 56 --slippage <percentage> --mev true --gasLevel MEDIUM --json` and `baw market-order list --orderId <orderId> --json`; uncertain submissions are reconciled via the documented token/time-filtered order list. Provider states are limited to `PENDING`, `FINISHED`, and `FAILED`. A `FINISHED` response with valid refund entries is shown as partial fill; missing refund data does not prove a full fill. The quote response contains no documented fee estimate, so the interface makes this limitation explicit and requires a configured BNB reserve.
- The `/agent` UI distinguishes quote eligibility, quote expiry, approval-required, submission, pending, partial fill, final provider status and unknown outcomes. It requires a deliberate **Approve and Execute This Trade** action, displays the actual trade details and warnings, labels BAW as the operator wallet, and never reports a CLI submission acknowledgement as a verified fill. Mocked CLI/API tests do not establish live execution availability.
- Live BAW order submission is currently blocked by unset production operator-token and execution settings, no durable database volume, and an empty BAW balance response. No live order has been submitted. Before enabling production execution, configure secrets server-side on the persistent BAW host, provision the durable volume and conservative limits, and verify trade/fee funding. The installed BAW security procedure also requires a token audit or explicit user acknowledgement when audit data is unavailable.
- The endpoint reports that `AltanaWalletProvider` and `TWAKProvider` are available from the installed BNB Agent SDK, but it does not instantiate either provider. Both require separate custody/session setup and would bypass the user's wallet confirmation if used to broadcast from this route.
- ERC-8004 registration and ERC-8183 job creation are not performed. The telemetry intentionally reports no registration ID, job ID, or transaction hashes.
- x402 settlement is disabled because no ERC-8183 commerce job is created in wallet-confirmation mode.
- `BNB_AGENT_KEY` is intentionally not read. A shared server key would let public callers spend from one wallet; future live execution requires authenticated per-user delegated sessions, least-privilege call/spend caps, durable trigger storage, and a monitored worker.
- `NEXT_PUBLIC_BSC_RPC_URL` configures the existing wagmi BSC transport; it is a public RPC URL, not a credential.

## Credential And Signing Boundaries

- `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` are read in server-side `lib/binance.ts`; do not expose either through a `NEXT_PUBLIC_` variable.
- EVM transaction sending and EIP-712 signing happen through the connected wallet in the browser. The wallet handles transaction signing and broadcast; private keys and raw signed transactions are never sent to the app server.
- The order-submit route validates request shape and forwards the signature to Binance. It does **not** independently recover or verify the signer locally.
- The current transaction destination is supplied by the upstream swap response. The app checks its address shape and simulates the call, but does not maintain an allowlist of Binance router contracts. Confirm official router destinations before treating this as a production custody/security review.

## Spot Eligibility And Regional Rules

Listings, detail pages, trade pages, quote, swap, and approval request entry points share a conservative spot-only filter. It excludes a short known ticker blacklist, explicit leverage fields, and leveraged/inverse descriptions. This is a product filter, **not** issuer approval, a complete security classification, legal advice, or a substitute for reviewing each current API record.

The hackathon and Binance Web3 developer product have restricted-region and sanctions eligibility rules. The UI links the official prohibited-region list but does not geofence or determine eligibility. Participants and users must review current official terms and their applicable laws.

## Explicitly Not Integrated

- Autonomous agent execution, Altana/TWAK session configuration, ERC-8004 registration, ERC-8183 commerce settlement, and x402 payment flows. The BNB Agent SDK and the Binance agentic-wallet skill are installed, but are not active signing integrations.
- Distributed per-client API rate limiting. The current Binance request queue is process-local and is not sufficient by itself for a horizontally scaled public deployment.
- Automated local EIP-712 signer recovery and persistent replay tracking. Binance remains the external order-submission boundary.

## Before Public Mainnet Use

Verify the complete supported-token metadata against the official spot-only track requirement; validate aggregator router and spender destinations against current official contract data before allowlisting; decide whether to fetch fresh swap calldata immediately before signing; configure persistent edge/API rate limits and monitoring; test quote expiry, account/chain switching, approval and reverted transactions with small amounts; and run the production build and browser wallet tests on the deployment target.

## Durable Autonomy Foundation

PostgreSQL migration 6 adds owner-scoped schedules, execution claims, delegated-custody records,
alerts, and verified market-calendar snapshots. `POST /api/agent/schedules` stores a bounded
monitoring schedule against a SHA-256 policy snapshot hash. `POST /api/agent/worker` is an
authenticated external worker entry point that atomically claims due schedules and creates replayable
execution claims. The worker is monitoring-only and sets no transaction-simulation or submission state.

US exchange-calendar evidence is provider-backed: `WOLV_US_MARKET_CALENDAR_URL` must be an HTTPS
endpoint returning exact dates, session state, UTC session minutes, and fresh provider timestamps.
Missing, malformed, stale, or unavailable calendar evidence fails closed; no holiday data is invented.

Policy execution intents use canonical, versioned JSON, owner and smart-account address validation,
a testnet-only chain restriction, 0.5-BNB and 100-bps caps, a policy hash, nonce, and short expiry.
Owner signatures are recoverable and verified before use. This is authorization framing only; it does
not provision credentials, grant a wallet session, submit a UserOperation, or bypass transaction simulation.

`POST /api/agent/intents` binds an authenticated wallet session to a signed, canonical testnet intent
and atomically consumes its nonce in PostgreSQL migration 7. A repeated owner/nonce pair is rejected with
`INTENT_REPLAY_REJECTED`. This route only records replay-bound authorization; it does not submit a
UserOperation, sign a transaction, or enable execution.

## On-Chain Policy Enforcement

The ERC-7579 `TradingAgentPolicyValidator` is the final execution boundary. It supports
smart-account-configured, account-scoped policy records containing a policy hash, delegated intent signer,
maximum trade value, and expiration. No trade is accepted until an explicit policy is configured.
Clearing a policy therefore disables execution for that account.

Each BUY call carries an ABI-encoded EIP-712 authorization envelope appended after the standard
PancakeSwap `swapExactETHForTokens` arguments. The delegated signer is recovered and checked against
the signer configured for that account. The signature binds the smart account, policy hash, router,
input and output tokens, recipient, input value, minimum output, 15-second router deadline, slippage
and price-impact limits, intent expiry, and a unique bytes32 nonce. The hook decodes those values from
the actual Kernel execution payload and compares them with the signature; it never trusts a separate
caller-declared spend amount. It also checks the fixed router and WBNB-to-approved-token route, the
account recipient, per-trade cap, rolling seven-day volume, pause, and revocation before execution.
The router's ABI accepts the trailing envelope; this must remain covered by fork/integration tests for
each approved router.

The BSC mainnet router fork regressions live in `test/TradingAgentPolicyValidatorFork.t.sol`; run them
with `BSC_MAINNET_RPC_URL=<rpc-url> forge test --match-contract TradingAgentPolicyValidatorForkTest`.
They exercise the current PancakeSwap V2 router and require Foundry plus a reachable BSC mainnet RPC.

The account integration uses ZeroDev Kernel v3.1 with EntryPoint 0.7. The validator is registered as
a `KernelValidatorHook`; Kernel invokes its `preCheck` and `postCheck` around account execution.
Policy configuration, clearing, and account revocation are callable only by the smart account itself.
The hook narrowly permits those exact calls through its pre-execution check so the account owner can
submit them with the Kernel owner validator; session-key permissions remain restricted to the approved
router BUY call. The guardian can only control the global pause switch.

Market quote age is capped at 20 seconds off-chain. The executor checks the intent age again immediately
before UserOperation submission and aborts expired work. The on-chain swap deadline is at most 15 seconds
from intent construction and is signed and validated against the router calldata. Market freshness,
calendars, and strategy evidence remain off-chain; they are not represented as on-chain proofs.

The worker now requires a configured policy and signer before creating an execution intent. The
executor re-reads on-chain policy, requires the delegated signer to match, atomically allocates a
per-account nonce with Redis `INCR`, signs the exact transaction parameters with EIP-712, and appends
the envelope before UserOperation submission. The worker does not choose nonces. Redis failure blocks
signing and submission; counters are never decremented, reset, or expired, so failed attempts burn
their nonce. Production Redis must have durable persistence and must not evict nonce keys. Submission
remains disabled by default and the existing separate mainnet authorization gates remain in force.

The browser helper `configureAgentPolicy` in `lib/setupAgentPolicy.ts` accepts a connected,
ZeroDev Kernel account client configured with the owner's sudo validator and a matching public client. It installs the hook with
`installModule(4, validator, 0x00 || abi.encode(targetToken))` when needed, waits for that
UserOperation, verifies the installation and token, then sends a separate owner-signed
`setAccountPolicy` UserOperation. These must be separate calls: the hook currently accepts only
Kernel's single-call execution mode and would reject a batched install-plus-policy operation. The
helper computes the fixed-width `abi.encodePacked` policy hash and confirms both receipts. This is a
callable frontend integration helper; no policy transaction has been submitted from this repository.

The previously deployed testnet hook predates this signed-envelope enforcement and cannot be upgraded
in place. It must not be used for agent execution. Deploy the updated implementation, configure each
account's policy hash, delegated signer, cap, and expiry through a UserOperation signed by that
account's owner, and verify those values against the account's approved ZeroDev session before
enabling any testnet execution. The guardian cannot set or alter account policy. A successful contract
deployment alone is not production readiness.

For a new testnet deployment, `npm run deploy:testnet-policy` reads `PRIVATE_KEY` and
`BSC_TESTNET_RPC_URL` locally, verifies chain ID 97 and the router/EntryPoint contracts, and deploys
the new hook. After installation, `npm run configure:testnet-policy -- --hook <hook> --account
<smart-account> --target-token <installed-token> --intent-signer <approved-session-key>
--max-trade-wei <integer> --expires-at <unix-seconds> --confirm-testnet` computes
`keccak256(abi.encodePacked(targetToken, maxTradeValue, expiresAt, intentSigner))`, verifies the token
against the installed hook configuration, and only builds the Kernel execution calldata; it does not
broadcast or sign. Since these fields are all fixed-width, this packed encoding is unambiguous. The
same hash is available to the frontend through `hashAgentPolicy` in
`lib/agentPolicyHash.ts`. Submit the generated call through the smart account using its owner
validator. The signer must be the same EOA as the authorized ZeroDev session key. Never put private
keys in chat or source control.
