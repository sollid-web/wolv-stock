# Binance Capability Matrix — WOLV

**Status:** discovery and read-only provider validation  
**Target chain:** BNB Smart Chain (BSC, chain ID 56)  
**Safety boundary:** this probe never signs, submits, broadcasts, approves, swaps, transfers, or places an order.

## Executive finding

Binance exposes two different integration surfaces. They must remain separate in WOLV:

1. **Binance Agentic Wallet (BAW)** is a user-authorized wallet agent accessed through the `baw` CLI. It uses Binance-managed MPC signing and enforces wallet settings, token scope, daily quotas, session expiry, and risk confirmations.
2. **Binance Web3 API** provides signed API access to market/RWA data, quotes, transaction construction, simulation, and broadcast endpoints. API credentials do not constitute authority to sign for a user's wallet. A transaction still needs an authorized signer.

Do not treat BAW CLI success, a Web3 API quote, or an unsigned transaction as proof of autonomous execution or settlement.

## Capability matrix

| Capability | Provider | Evidence / constraint | WOLV status |
|---|---|---|---|
| RWA token catalogue | Web3 API | Signed GET `/api/v1/dex/market/rwa/tokens` | Documented; probe required |
| RWA price / reference price | Web3 API | Signed GET `/api/v1/dex/market/rwa/price` | Documented; probe required |
| Underlying company and market data | Web3 API | Signed GET `/api/v1/dex/market/rwa/underlying-profile` and `underlying-market` | Documented; probe required |
| Candles / token market data | Web3 API | Signed GET market endpoints | Existing main-branch adapter; validate schema/freshness |
| Aggregator quote | Web3 API | `/api/v1/dex/aggregator/quote`; RWA routes are RFQ, include quote ID (~30s TTL), exact amounts, vendor, impact and estimated fees | Strict parser and worker quote stage implemented; live response still requires user-environment validation |
| Swap / RFQ order construction | Web3 API | `/api/v1/dex/aggregator/swap` builds unsigned EVM swap data or RFQ EIP-712 payload | Quote and RFQ payload validators implemented; not yet live-verified or signed |
| Transaction simulation | Web3 API | Pre-transaction simulation endpoint | Must be performed immediately before signing |
| Transaction broadcast | Web3 API | Accepts an already signed transaction | Requires separate wallet signer |
| Wallet sign-in / session | BAW CLI | QR-based sign-in, session expiry, sign-out/revocation | Requires interactive user onboarding |
| BAW balances / settings / quota | BAW CLI | Read-only wallet commands | Can be monitored by worker while session is valid |
| BAW market-order quote | BAW CLI | Read-only quote | Probe separately from Web3 API quote |
| BAW market-order swap | BAW CLI + Secure Auto Sign | Secure Auto Sign is limited to supported transaction classes; no evidence yet that it can sign Binance RWA RFQ typed data in a headless worker | **Not proven for WOLV RWA RFQ** |
| BAW limit orders | BAW CLI | Order lifecycle and cancellation commands documented | Validate unattended trigger behavior and session constraints |
| BAW external transaction / EIP-712 signing | BAW CLI / Developer Mode | Official Agentic Wallet skill requires sign-message preview, display of parsed message and risks, explicit user confirmation, then sign-message execute; result may remain PENDING_CONFIRMATION | **Not suitable for unattended RWA RFQ signing** |
| BSC testnet through BAW | BAW | Public docs list BSC mainnet chain ID 56; no BSC testnet support established here | Unverified; do not assume |
| BAW onboarding | Binance App / supported agent | Binance FAQ says each user currently has one Agentic Wallet and warns against scanning third-party website QR codes; direct WOLV-hosted QR onboarding is not an acceptable assumption | **Integration approval / supported-agent path required** |\n| Multi-user unattended worker | WOLV | Requires per-user session isolation, revocation handling, leases, durable idempotency and reconciliation; one BAW wallet per user constrains agent tenancy | Not proven |

## Hard roadblocks to resolve

### 1. Autonomous authorization

BAW's wallet security settings are controlled by the user in Binance. The public wallet overview describes market swaps as quote → user confirmation → execution; high-risk operations may be rejected or sent for App confirmation. Therefore, **do not assume that a background worker can execute every trade without a confirmation prompt**.

For WOLV's RWA route, Binance Web3 API returns executionMode=RFQ and requires EIP-712 signing. The official BAW external-sign skill mandates a preview, risk display and explicit user confirmation before executing sign-message; this is a human gate, not the desired unattended path. A BAW market-order flow may still be tested separately for ordinary supported swaps, but it must not be assumed to cover RFQ.

A BAW capability test must establish, with a dedicated low-value test wallet and explicit consent:
- Whether the intended trade type executes unattended under configured wallet policy.
- Whether an App confirmation is required for the selected token, amount, route, or risk class.
- Whether the session remains usable by a long-running worker and what happens on expiry/revocation.
- Whether Developer Mode / external transaction signing is available to the account and what constraints apply.

If BAW requires per-trade confirmation, it can still be a supported custody adapter, but it cannot be WOLV's sole autonomous execution path.

### 3. Signing authority

Web3 API API-key/secret authentication authenticates WOLV to Binance's API. It does not grant WOLV the user's private key. RFQ execution requires an EIP-712 signature from the exact wallet used in /quote. WOLV needs a server-side signer authorized once and constrained by wallet-level policy. Privy is a candidate because its EVM SDK exposes signTypedData and its policy engine can constrain typed-data actions; it requires a dedicated WOLV trading wallet or a user-authorized delegated signer. This custody path is not connected or approved.

### 4. Session and user isolation

Never keep one global BAW session for all WOLV users. Store a provider connection per owner, encrypt session material at rest, isolate worker jobs by owner/wallet, and stop execution immediately when a session expires or is revoked. Do not log secrets, session tokens, signatures, or raw authentication output.

### 5. Settlement truth

A provider's `success: true` or order ID means submission, not settlement. Track order state to a terminal status and independently verify the transaction receipt and token balance deltas. Unknown submission state must be reconciled before retrying; never blindly resubmit.

## Read-only probe

The repository includes `scripts/binance-provider-probe.mjs` and a strict quote normalizer at `services/autonomy/binance-quote.ts`.

Required environment:
- `BINANCE_API_KEY`
- `BINANCE_SECRET_KEY`

Optional:
- `BINANCE_PROBE_WALLET_ADDRESS` — enables a read-only aggregator quote request.
- `BINANCE_PROBE_TOKEN_ADDRESS` — choose a specific BSC RWA token; otherwise the probe selects the first returned BSC RWA token.

Run:
```bash
node --test scripts/binance-provider-probe.test.mjs
node scripts/binance-provider-probe.mjs
```

The live probe performs GET requests only. It does not invoke BAW, sign transactions, request approval calldata, submit orders, or broadcast transactions. When a wallet is configured, it reports quote field names and types without printing values. The worker quote adapter validates the documented RWA RFQ response, persists a redacted evidence event, and stops at `QUOTED`; it does not approve risk or execute.

## Go / no-go criteria for autonomous execution

Do not enable unattended execution until all are true:

1. A user-authorized signing mode is demonstrated to work without per-trade human confirmation for the intended strategy and risk envelope.
2. Session expiry, revocation, policy rejection, and worker restart are tested.
3. Every order is idempotent and persisted before submission.
4. Quote freshness, token identity, chain ID, amount, slippage, recipient, spender, and calldata are validated.
5. Simulation succeeds against the exact transaction to be signed.
6. Settlement is verified from BSC receipts and token balance deltas.
7. Per-user spend caps, token allowlists, daily limits, max position, max slippage, cooldown, and global kill switch are enforced independently of the LLM.
8. Failure and uncertain-submission paths never create duplicate trades.

## Source references

- [Binance Agentic Wallet overview](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)\n- [Binance Agentic Wallet FAQ — Secure Auto Sign, onboarding and wallet limits](https://www.binance.bh/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)\n- [Binance Agentic Wallet external signing — Developer Mode flow](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md)
- [Binance Agentic Wallet CLI package](https://www.npmjs.com/package/@binance/agentic-wallet)
- [Binance Web3 API RWA Data](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data)
- [Binance Web3 API Wallet API](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/wallet-api)
- [Binance Web3 API error codes](https://web3.binance.com/en/dev-docs/products/wallet-api/error-codes)


## Newly verified: Binance MCP Server is a separate execution product

Official Binance documentation now exposes a second remote integration at `https://agent.binance.com/mcp/agentic`. It must **not** be conflated with the BAW CLI / Web3 wallet integration.

| Surface | Custody / account | Remote operation | Approval model | WOLV decision |
|---|---|---|---|---|
| Binance MCP Server (Agent OS) | Dedicated Binance **Agentic sub-account** on Binance.com | Remote HTTP MCP endpoint; compatible clients include ChatGPT, Codex, Claude, VS Code and others | Official docs say every order, cancel and internal transfer is confirmed by the user before submission | Useful for read/account access and assisted CEX trading; **fails WOLV's no-routine-approval requirement** |
| Binance Agentic Wallet (BAW) | Separate on-chain MPC wallet in Binance Wallet; one per user currently | Skills/CLI agent connection; QR pairing through a trusted agent | Secure Auto Sign can execute supported transactions without per-transaction confirmation after user authorization; custom Developer Mode calls retain preview/risk checks and can require App confirmation | Candidate for supported BSC swaps, but unattended server-worker/session operation is not yet proven |
| Binance Web3 API | No custody; API key authenticates API calls | Direct server-to-server REST | Quotes/build/simulation are not signing authority; broadcast requires an already signed transaction | Market/RWA data and transaction preparation adapter only |

### Binance MCP Server: what it does and does not solve

The official Agent OS MCP documentation confirms:
- Remote MCP endpoint: `https://agent.binance.com/mcp/agentic`; it avoids placing Binance API keys on the user's device.
- Scopes include public market data, Agentic sub-account account reads, supported Spot/Margin/Convert/Futures trading, and internal transfers.
- There is no withdrawal scope. Funds must be manually moved into the isolated Agentic sub-account by the user.
- **Every trade, cancellation and internal transfer requires user confirmation before submission.**
- Users can disconnect agents and invoke an emergency stop that disconnects agents and cancels Spot, Margin and Futures positions/orders in that Agentic sub-account.
- Authorization expiry requires reconnecting.

This is a good safety-first remote integration, but it recreates the manual approval bottleneck that WOLV is explicitly trying to remove. Do not use this MCP Server as the primary autonomous execution adapter. It may be offered as an optional supervised CEX provider.

### BAW: autonomy boundary

The latest Binance Agentic Wallet FAQ (updated 2026-11-05) says Secure Auto Sign, once authorised, allows supported transactions to execute without individual transaction confirmations. It also warns against scanning QR codes from third-party websites and says users should pair only through Binance AI Pro or trusted agents.

For custom contract calls and message signing, the official BAW skill documentation requires:
1. Check Developer Mode in the Binance App; it is not enabled through the CLI.
2. Preview the exact call and inspect parsed transaction, simulation, risk details and authority changes.
3. Execute only with the successful preview's request ID.
4. Respect `requireConfirmation`: false can broadcast directly; true creates an App-pending action. Risk-intercepted previews have no usable request ID.
5. Developer Mode is time-limited (documented as seven days) and has a balance cap.

Therefore, BAW is a plausible autonomous signer for the specific supported operations where Secure Auto Sign actually returns a no-confirmation path. It is **not** a blanket signer for arbitrary WOLV calldata. A real supported-operation test remains mandatory.

### Remote worker feasibility: current answer

**Not proven yet.** The remote MCP Server is reachable as a remote service but its documented confirmation model is unsuitable for hands-off execution. BAW supports trusted-agent integrations and a CLI/skills runtime, but public documentation does not establish that WOLV can safely own a durable remote BAW session in a backend worker without relying on an interactive trusted-agent host or violating Binance's QR onboarding guidance.

Do not build a WOLV-hosted QR pairing page, copy BAW session files into a shared backend, or assume a local CLI session can be moved to a cloud worker. The next proof must use Binance's supported trusted-agent onboarding path and establish session persistence, revocation, headless operation, and Secure Auto Sign coverage before any production adapter is written.

### Architecture decision

Keep three provider interfaces distinct:
- `MarketDataProvider`: Binance Web3 API and independent market feeds. Read-only.
- `CexExecutionProvider`: Binance MCP Server or official exchange APIs for supervised CEX orders. User-confirmation semantics remain explicit.
- `OnchainExecutionProvider`: BAW for supported auto-sign operations, with a separately validated delegated smart-account signer only if custom BSC contract calls are required and the user explicitly authorizes that model.

The WOLV strategy/risk engine must sit above all providers. It independently enforces user budgets, token allowlists, max order/position size, max slippage, price-impact limits, daily loss limits, cooldowns, duplicate-order prevention, and a global kill switch. The LLM may propose an action; deterministic policy code decides whether it is eligible. Routine eligible orders should not pause for a human click, but policy violations, revoked credentials, anomalous destinations, unsupported transaction classes and uncertain settlement must fail closed.

### Next proof-of-capability sequence

1. Confirm the target execution product for WOLV's BSC RWA/DEX strategy is BAW (not the CEX Agentic sub-account MCP Server).
2. Install Binance's official Agentic Wallet skill in a trusted-agent environment; use Binance's approved pairing route only.
3. Record `baw wallet status`, wallet settings, chain support, session expiry and Secure Auto Sign state without exposing session material.
4. On a dedicated low-value test wallet, test only a supported, reversible, low-risk market swap; capture whether the quote/order path broadcasts unattended or returns App confirmation.
5. Separately test one harmless contract-call preview to understand Developer Mode behavior; do not execute custom calldata merely to test it.
6. Test session expiry, explicit sign-out/revocation, worker restart, provider outage and ambiguous submission reconciliation.
7. Only after these results decide whether BAW can be hosted by WOLV or whether WOLV needs a distinct delegated smart-account execution rail.

No live trading or funds movement is authorised by this document.

## Additional official references

- [Binance Agent OS MCP Server documentation](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic)
- [Binance Agent OS announcement](https://www.binance.com/en-AE/support/announcement/detail/07d45cdd3831498f8a4ff339031a8480)
- [Binance Agentic Wallet FAQ, updated 2026-11-05](https://www.binance.com/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)

## Quote endpoint contract and current WOLV implementation

Binance's current Trading API documentation states that:
- `/api/v1/dex/aggregator/quote` returns one route per vendor, sorted by output amount; each route has a `quoteId` with an approximately 30-second TTL.
- RWA/equity assets return `executionMode: RFQ`. The wallet address is required for RFQ routes and must match the wallet signing the subsequent typed-data order.
- The response includes `fromTokenAmount`, `toTokenAmount`, `tradeFee`, `estimateGasFee`, `priceImpactPercent`, token metadata, route/vendor and honeypot flags.
- Binance explicitly describes `tradeFee` and `estimateGasFee` as estimates; accurate gas requires the separate gas-price and gas-limit endpoints.

WOLV now validates the chain, wallet and token identities, amount, RFQ mode, quote freshness, quote ID, route, output, fee/gas estimate, price impact, token decimals/taxes and honeypot flags. It stores only normalized fields, hashes and a conservative 20-second expiry in the execution event. A successful quote is **not** risk approval and is not a transaction or fill.

Official reference: [Binance Web3 Trading API](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api).


## WOLV portfolio controls (2026-11-10)

The autonomy branch now includes a Supabase migration for owner-scoped paper portfolios, allowlists, budget reservations, positions and idempotent paper quote fills. Defaults are deliberately disabled with emergency stop enabled and zero budget. Reservation RPCs require an execution intent already in `RISK_APPROVED`; paper-fill commit requires `SIMULATED`, the same unexpired quote ID and exact expected output amount.

This ledger is not connected to the worker yet and the migration has not been confirmed applied. It does not move real funds. The exact-decimal reference-edge calculator is also present, but a reliable USD gas cost and conservative exit valuation are still required before the risk engine can approve an opportunity.


WOLV also now contains a read-only RFQ order-preparation adapter. It builds the swap response with approval construction disabled, validates route/token/amount/vendor consistency against the quote, checks EIP-712 metadata, hashes the typed-data payload and flags unexpected approval data. It does not sign or submit. The polling worker currently stops at the validated quote; the order-preparation adapter is not yet connected to that loop.

## RFQ signing-provider decision

BAW's external EIP-712 signing path is not a valid unattended default: the official Binance Agentic Wallet skill instructs agents to preview the message, display risks, obtain explicit user confirmation, and only then execute the signature. A pending App confirmation may still occur.

Privy is the current candidate for a separately authorized RFQ signer because its official Node SDK exposes EVM typed-data signing and its wallet policy engine supports constraints on typed-data signatures, contract allowlists and spend limits. This is not a drop-in connection to the existing Reown wallet. It requires a deliberate custody/authorization design (preferably a separate bounded WOLV trading wallet), policy configuration, BSC compatibility validation and a user-approved onboarding step. No wallet has been imported, created, funded or connected by this implementation.

References:
- [Binance Agentic Wallet external signing](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md)
- [Privy wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)
- [Privy Node SDK EVM typed-data signing](https://app.unpkg.com/@privy-io/node@0.35.0/files/public-api/services/ethereum.d.mts)
