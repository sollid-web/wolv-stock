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
| Aggregator quote | Web3 API | Read-only quote endpoint; requires wallet address for some RWA/RFQ routes | Documented in existing main-branch code; probe required |
| Swap transaction construction | Web3 API | Returns unsigned transaction data | Not signing authority |
| Transaction simulation | Web3 API | Pre-transaction simulation endpoint | Must be performed immediately before signing |
| Transaction broadcast | Web3 API | Accepts an already signed transaction | Requires separate wallet signer |
| Wallet sign-in / session | BAW CLI | QR-based sign-in, session expiry, sign-out/revocation | Requires interactive user onboarding |
| BAW balances / settings / quota | BAW CLI | Read-only wallet commands | Can be monitored by worker while session is valid |
| BAW market-order quote | BAW CLI | Read-only quote | Probe separately from Web3 API quote |
| BAW market-order swap | BAW CLI + Secure Auto Sign | Binance FAQ says Secure Auto Sign, once enabled and authorised, can execute supported transactions without individual confirmations; confirm exact market-order coverage on the target account | **Promising; must prove end-to-end** |
| BAW limit orders | BAW CLI | Order lifecycle and cancellation commands documented | Validate unattended trigger behavior and session constraints |
| BAW external transaction signing | BAW CLI / Developer Mode | Contract-call preview and execute are a two-step flow; explicit confirmation is required, and some calls may still become App-pending | **Not suitable as the default unattended custom-call signer** |
| BSC testnet through BAW | BAW | Public docs list BSC mainnet chain ID 56; no BSC testnet support established here | Unverified; do not assume |
| BAW onboarding | Binance App / supported agent | Binance FAQ says each user currently has one Agentic Wallet and warns against scanning third-party website QR codes; direct WOLV-hosted QR onboarding is not an acceptable assumption | **Integration approval / supported-agent path required** |\n| Multi-user unattended worker | WOLV | Requires per-user session isolation, revocation handling, leases, durable idempotency and reconciliation; one BAW wallet per user constrains agent tenancy | Not proven |

## Hard roadblocks to resolve

### 1. Autonomous authorization

BAW's wallet security settings are controlled by the user in Binance. The public wallet overview describes market swaps as quote → user confirmation → execution; high-risk operations may be rejected or sent for App confirmation. Therefore, **do not assume that a background worker can execute every trade without a confirmation prompt**.

A BAW capability test must establish, with a dedicated low-value test wallet and explicit consent:
- Whether the intended trade type executes unattended under configured wallet policy.
- Whether an App confirmation is required for the selected token, amount, route, or risk class.
- Whether the session remains usable by a long-running worker and what happens on expiry/revocation.
- Whether Developer Mode / external transaction signing is available to the account and what constraints apply.

If BAW requires per-trade confirmation, it can still be a supported custody adapter, but it cannot be WOLV's sole autonomous execution path.

### 3. Signing authority

Web3 API API-key/secret authentication authenticates WOLV to Binance's API. It does not grant WOLV the user's private key. The Web3 broadcast endpoint accepts a signed transaction. WOLV must supply an independently authorized signing provider (BAW external signing, an EIP-7702 delegated session, or another user-controlled smart-account signer).

### 4. Session and user isolation

Never keep one global BAW session for all WOLV users. Store a provider connection per owner, encrypt session material at rest, isolate worker jobs by owner/wallet, and stop execution immediately when a session expires or is revoked. Do not log secrets, session tokens, signatures, or raw authentication output.

### 5. Settlement truth

A provider's `success: true` or order ID means submission, not settlement. Track order state to a terminal status and independently verify the transaction receipt and token balance deltas. Unknown submission state must be reconciled before retrying; never blindly resubmit.

## Read-only probe

The repository includes `scripts/binance-provider-probe.mjs`.

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

The live probe performs GET requests only. It does not invoke BAW, sign transactions, request approval calldata, submit orders, or broadcast transactions. It reports endpoint-level outcomes and exits non-zero on failed required checks.

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
