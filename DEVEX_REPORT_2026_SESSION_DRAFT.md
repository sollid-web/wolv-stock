# WOLV Spot Lens — Developer Experience Report (2026 session draft)

**Prepared:** 4 October 2026  
**Project:** WOLV Spot Lens  
**Purpose:** Evidence-based draft of this session's development experience and audit outcomes for the BNB Hack: Tokenized Stocks Edition.

> **Builder review required before submission.** The hackathon asks for specific firsthand developer observations and does not accept perfunctory or AI-generated reports. This draft records evidence visible in the repository and the builder's reported wallet-testing experience; it is not a substitute for the builder's own final account. Verify that every first-person observation matches your experience, add the missing personal details, and rewrite the narrative in your own words before submitting.

## Executive summary

WOLV Spot Lens is a BSC spot tokenized-equity monitor focused on Ondo and bStocks. It compares issuer/listed reference data with executable aggregator quotes, normalizes prices per underlying share, and offers a user-approved trade path.

This session exposed an important integration mismatch in that trade path. Binance simulation reported success, but the connected wallet did not support the raw-transaction signing method WOLV requested. The app therefore failed before broadcasting and did not show the expected wallet confirmation. A subsequent connection attempt also returned a pending-request error. Browser console output supplied by the builder showed Binance Wallet's injected provider failing to initialize an internal broadcast channel; it did not establish the cause of that extension failure.

The transaction flow was changed to use the wallet's standard send-transaction path for approval and direct SWAP execution. WOLV still simulates the transaction before asking for wallet approval, and it now checks the resulting BSC receipt through the configured public RPC client. Connection attempts were also guarded against overlapping requests, and pending-request errors were made clearer.

The changes have editor diagnostics but have **not** been tested against a live wallet or deployed to production in this session. The extension/provider connection error may remain. The security audit found no confirmed exploitable vulnerability from repository evidence, but identified trust-boundary and operational-hardening items that remain relevant before public mainnet use.

## Product and integration context

The product is intended to help a user:

1. Find a tokenized-equity ticker represented on supported BSC venues.
2. Compare issuer/reference information with an executable spot quote.
3. Understand normalization, quote age, market status, price impact, and limitations.
4. Inspect a simulation and approve any required USDT allowance in their wallet.
5. Send a spot trade only after explicit wallet confirmation.

The repository records integrations with Binance RWA data, the aggregator quote/swap/approval endpoints, and Transaction API simulation. The app's RFQ path uses Binance-returned EIP-712 typed data and Binance order submission. See [README.md](./README.md) and [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md).

## Session timeline: what went wrong and what changed

### 1. Simulation succeeded, but the wallet did not open a confirmation

The builder reported clicking **Approve USDT** and seeing an error instead of a wallet prompt. The screenshot showed an approval preflight marked `SUCCESS`, followed by an error explaining that the wallet could not sign raw transactions required for Binance broadcast.

The code path explained the apparent contradiction:

- The app obtains approval calldata and checks the simulated allowance in [TradeButton.tsx](./components/TradeButton.tsx).
- A successful preflight only means the simulated transaction passed; it does not approve USDT or broadcast anything.
- The old flow called `walletClient.signTransaction(...)` in [useWallet.tsx](./hooks/useWallet.tsx), requiring the wallet to return a raw signed transaction.
- If that method is unsupported, execution exits before the broadcast call. No transaction hash is produced by that flow.

This was an integration/capability mismatch: simulation worked, but the wallet's supported confirmation interface did not match WOLV's raw-sign-and-relay design.

### 2. Disconnecting in WOLV did not clear the next wallet's pending-request warning

The builder reported disconnecting from the WOLV page, ending the first wallet session, and then encountering “Connection declined — a previous request is still active” while trying another wallet.

The WOLV disconnect action delegates to wagmi's `disconnect()` in [useWallet.tsx](./hooks/useWallet.tsx). That changes the app's connector/session state; it does not give WOLV a general method to cancel a request already pending inside a wallet extension or WalletConnect provider.

The console text provided by the builder included errors from an injected `inpage.js` provider: it could not obtain a channel secret or node ID and reported “Broadcast channel unavailable.” This is evidence of an error within the injected wallet provider's initialization/broadcast mechanism. It does **not** identify the underlying extension defect, prove that WOLV created the condition, or prove that the same mechanism caused every wallet's pending-request message.

### 3. Wallet transaction sending was changed

The approval and direct-SWAP flows were changed from `signTransaction` followed by Binance broadcast to `sendTransaction` through the connected wallet client:

- The wallet receives the transaction request and owns signing and broadcast.
- The user should receive the wallet's normal transaction confirmation when the wallet/provider supports this flow.
- Binance simulation, quote freshness checks, and BSC chain checks remain in the app.
- The app checks for the transaction receipt through the configured BSC public client.

The changes are in [useWallet.tsx](./hooks/useWallet.tsx) and [TradeButton.tsx](./components/TradeButton.tsx). Documentation was updated in [README.md](./README.md) and [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md).

This change addresses the raw-signing incompatibility. It does not guarantee that the Binance Wallet extension's injected provider can connect or initialize successfully.

### 4. Duplicate connection requests were guarded

The app's `connect` function now returns early if a connection attempt is already in flight. The AppKit connection button also prevents a second open while its modal or connector reports a connection in progress. A pending-request message is translated into user-facing guidance to finish or dismiss the wallet prompt before retrying.

These changes reduce duplicate requests initiated by WOLV. They cannot cancel a request held by the wallet itself or repair an extension's internal broadcast channel. See [useWallet.tsx](./hooks/useWallet.tsx) and [WalletSelector.tsx](./components/WalletSelector.tsx).

## Development and debugging loops

### Wallet approval loop

```text
User clicks Approve USDT
  -> WOLV fetches Binance approval transaction
  -> Binance simulation reports SUCCESS
  -> old flow requests raw signature (eth_signTransaction-equivalent)
  -> wallet does not support that method
  -> app exits before broadcast; no approval hash/allowance change
  -> flow changed to wallet-native sendTransaction
  -> live wallet validation remains outstanding
```

### Wallet connection loop

```text
WOLV starts wallet connection
  -> wallet/connector reports a request is already pending
  -> builder disconnects WOLV and ends first wallet session
  -> retry still reports pending request
  -> console shows injected-provider broadcast-channel initialization errors
  -> WOLV duplicate-request guards and clearer messaging added
  -> extension/provider cause remains unverified and requires live retest
```

### Repository audit loop

```text
Hackathon checklist review
  -> found product technically aligned but home screen not judge-first
  -> repo readiness audit recorded missing external submission evidence
  -> adversarial security pass traced actual routes and signing/broadcast flows
  -> preliminary concerns separated into confirmed issues,
     hardening, architecture limitations, and unsupported claims
  -> no confirmed high/critical exploit established from repository evidence
```

## Audit findings relevant to the build

### Confirmed implementation facts

- The app has quote freshness and a short-lived HMAC quote binding for token, amount, wallet, quote ID, and, when present, approval target. Implemented in [quoteBinding.ts](./lib/quoteBinding.ts).
- The approval route compares the returned approval spender to the quote-bound approval target. The swap route compares the SWAP destination to that target when the binding contains it. See [approve-transaction/route.ts](./app/api/approve-transaction/route.ts) and [swap/route.ts](./app/api/swap/route.ts).
- The app does not independently reconstruct or recover the signer for Binance-supplied RFQ typed data. WOLV forwards the signed RFQ order to Binance. This is an external trust boundary, not proof of an exploitable mutation.
- The rate limiter in [binance.ts](./lib/binance.ts) is process-local, not shared across serverless instances.
- The repository's [next.config.ts](./next.config.ts) does not define explicit security headers.
- Binance credentials are read server-side; `.env*` is ignored by [.gitignore](./.gitignore). No evidence from the reviewed repository showed the credentials being exposed to client code.

### Classification

| Audit observation | Session conclusion |
|---|---|
| RFQ typed-data values are not independently validated by WOLV | Confirmed trust-boundary limitation; no repository-evidenced mutation exploit |
| Router/spender has no static official-contract allowlist | Partially mitigated by quote-bound destination/spender comparisons; further allowlisting is defense-in-depth |
| Quote may be stale at execution | Freshness and quote-binding checks exist; swap details are fetched during quote preparation, then execution is blocked when the quote is stale. The code does not fetch new swap calldata immediately before wallet signing. |
| Public routes are unauthenticated | Public relay surface and quota-abuse consideration; not a wallet-drain finding by itself |
| Wallet race/session failure | No wrong-wallet execution demonstrated; the user's pending-provider failure is real but the root cause remains external/unverified |
| Security headers absent from repository config | Hardening recommendation; no concrete exploit established |
| Secrets exposed | Not supported by inspected code; server-only Binance credentials and ignored env files |
| Process-local rate limiting | Scalability/abuse-resistance limitation, not a confirmed exploit |

## What the audit got right, and what it did not establish

The initial readiness review correctly identified that the opportunity monitor was not the obvious homepage entry point and that public deployment, demo accessibility, and a complete judge journey could not be proved from the repository alone.

The later security review correctly identified areas requiring trust in Binance-provided payloads, missing global rate limiting, and absent explicit security headers. It did not establish that those conditions let an attacker mutate a signed trade, bypass wallet approval, or steal funds. The follow-up verification therefore treated them as trust-boundary, hardening, or architectural findings rather than confirmed high/critical vulnerabilities.

The wallet issue was not simply “simulation failed.” Simulation succeeded; the signing/broadcast method was incompatible with the tested wallet. Separately, the injected provider emitted its own initialization errors. The evidence does not support claiming that WOLV caused the provider error or that the wallet-native send change resolves it.

## Verification record and limitations

| Check | Result |
|---|---|
| TypeScript/editor diagnostics after wallet-flow edits | No errors reported for [useWallet.tsx](./hooks/useWallet.tsx), [WalletSelector.tsx](./components/WalletSelector.tsx), and [TradeButton.tsx](./components/TradeButton.tsx) |
| Earlier repository TypeScript, lint, production build | Passed during the earlier repo audit, before the wallet-native transaction-flow edits |
| Live approval prompt after wallet-native change | Not tested in this session |
| Live SWAP after wallet-native change | Not tested in this session |
| Binance Wallet injected-provider connection after guards | Not tested in this session; provider-console errors remain unresolved |
| Deployed production behavior | Not verified after these local changes |

No transaction, signing event, or approval should be claimed as newly completed by this session. The builder's earlier live-transaction experience is recorded in the existing development log, but this session's observed wallet failure did not produce evidence of a new on-chain transaction.

## Lessons for the next development cycle

1. A successful simulation is preflight evidence, not a wallet approval or transaction receipt.
2. Wallet signing and broadcast capabilities differ; use the wallet's standard user-confirmed send path for ordinary EVM transactions unless the product specifically requires raw transaction relay.
3. Treat wallet connection, transaction approval, transaction broadcast, and receipt confirmation as separate observable states.
4. An app disconnect cannot be presented as clearing every pending request inside a wallet extension or WalletConnect session.
5. Keep failure copy precise: distinguish “simulation passed,” “wallet confirmation unavailable,” “user rejected,” “broadcast submitted,” and “receipt verified.”
6. A repository audit can establish code behavior, but cannot establish deployed behavior or an external wallet's root cause without a controlled live reproduction.

## Priority actions before judging

1. Test the changed approval flow with the actual target wallet on BSC mainnet using a small, affordable amount; record whether the wallet confirmation appears, the transaction hash, and the receipt result.
2. Test the direct-SWAP flow separately and verify that receipt lookup works for wallet-broadcast transactions. Also decide whether the product requires new swap calldata immediately before signing; the current client obtains it during quote preparation and enforces quote freshness afterward.
3. Reproduce the connection issue in a clean browser profile with only one wallet extension active. Capture the wallet name/version, browser, connector path, exact sequence, and redacted console errors.
4. Verify the live deployed URL and public repository remain accessible; rehearse the primary judge journey from the deployed URL.
5. Make the reference-versus-executable monitor the judge's obvious entry point, as recorded in [HACKATHON_SUBMISSION_AUDIT.md](./HACKATHON_SUBMISSION_AUDIT.md).
6. For a final Developer Experience Report, add the builder's own account of API onboarding, time spent, documentation/support interactions, unexpected behaviors, and what changed in the builder's understanding. Do not claim any of those experiences unless personally observed.

## Builder's firsthand completion checklist

Before submitting a report based on this draft, the builder should personally confirm or edit:

- [ ] Which wallet and browser produced the first raw-signing error.
- [ ] Which wallet and connection path produced the pending-request message.
- [ ] Whether the wallet-native transaction prompt appeared after deployment.
- [ ] Whether an approval or swap was actually broadcast after the code change.
- [ ] What transaction hash and receipt demonstrate the result, if one exists.
- [ ] Whether the injected-provider console error reproduces with only one extension enabled.
- [ ] Which API documentation or support interactions personally affected implementation.
- [ ] Which observations in this draft should be rewritten or removed to accurately reflect firsthand experience.
