# Privy agent signer for autonomous BSC execution

## Decision

Privy is the preferred signer integration to implement next for WOLV's Binance RFQ path. Its official Node SDK exposes EVM typed-data signing, its server-side authorization context supports backend-controlled requests, and its wallet policy engine can constrain EIP-712 signing by domain and message fields.

This validates the technical route; it does not authorize WOLV to create, import, fund, or control a wallet. No Privy app, wallet, signer key, or live execution credential is currently connected.

## Why this fits WOLV

- Binance RFQ returns an EIP-712 payload and expects a signature before its submit endpoint can broadcast the order.
- Privy documents EVM typed-data signing and server-side SDK authorization contexts.
- Privy supports EVM-compatible networks with full wallet functionality, transaction building, policies and webhooks. BNB Smart Chain is an EVM network (chain ID 56).
- Privy explicitly documents agent-controlled wallets that can execute autonomously within policies, plus user-owned wallets with revocable additional signers.
- Its policy engine supports eth_signTypedData_v4 rules that restrict domain.chainId, domain.verifyingContract, and selected typed-message fields.

## Recommended custody model

Use a **separate, capped BSC execution wallet**, not the user's primary wallet.

1. The owner creates/authorizes the Privy app and its backend authorization key.
2. WOLV uses a dedicated BSC wallet with a small, explicit operating balance.
3. The wallet policy allows only the required EIP-712 signing method and exact Binance RFQ signing domain(s).
4. Typed-data message fields are constrained to the configured wallet, approved input/output tokens, maximum input amount, approved spender/contract, and bounded expiry once the exact Binance typed-data schema has been captured and reviewed.
5. Policy updates, wallet export and custody changes remain separately protected by owner/key-quorum controls.
6. WOLV signs the RFQ order through Privy, submits the signature through Binance, then independently verifies BSC settlement. Privy is the signer, not the market-data or execution-order provider.

This isolates autonomous trading capital from the user's primary wallet. A user-owned wallet with a revocable agent signer is also supported by Privy, but the current WOLV wallet integration is Reown/Wagmi rather than a Privy embedded wallet, so a dedicated execution wallet is the simpler initial route.

## Policy requirements

The production policy must be default-deny and must not be a broad eth_signTypedData_v4 allow rule.

Required constraints:
- chain_type: ethereum, domain.chainId = 56.
- domain.verifyingContract must be an explicit allowlist populated from verified Binance RFQ order fixtures.
- primaryType and the typed-data field schema must match the approved RFQ payload version.
- Wallet, token-in, token-out, amount-in, spender, nonce and expiry fields must be checked against the validated WOLV execution intent and current quote.
- Reject unrecognized fields, unsupported typed-data formats, stale quote expiry, unknown contracts and any signing request that is not tied to a persisted live attempt.
- Do not grant eth_sendTransaction, wallet export, arbitrary RPC, arbitrary personal-sign, policy-update or wallet-management permissions to the trading worker.

Privy's policy examples document restrictions on EIP-712 domain chain ID/verifying contract and typed-data message fields. The exact Binance RFQ message schema is not yet available as a verified live fixture, so no production policy JSON should be generated from assumptions.

## Server configuration (not yet enabled)

Expected server-only settings after explicit custody authorization:
- PRIVY_APP_ID
- PRIVY_APP_SECRET
- PRIVY_WALLET_ID
- PRIVY_WALLET_ADDRESS
- PRIVY_AUTHORIZATION_PRIVATE_KEY

Never use NEXT_PUBLIC_ prefixes for these values. Never commit them or send them in chat. The authorization private key is a Privy API request-signing credential; it is distinct from the wallet's secp256k1 signing key held within Privy's wallet infrastructure.

The SDK dependency should be added with a lockfile update in the same change. The repository currently does not include @privy-io/node; no dependency or lockfile was changed in this research step.

## Implemented signer safety layer

WOLV now includes services/autonomy/privy-eip712-signer.ts as a fail-closed signer adapter around an injected Privy signing client. Before the client is called, it requires:
- JSON EIP-712 data (opaque hex payloads are rejected).
- BSC chain ID 56 and an explicitly allowlisted verifying contract.
- Exact approved primary type and exact type schema.
- Exact declared message shape, with no undeclared message fields.
- Explicit role bindings for all configured critical fields (wallet, tokens, amounts, expiry, nonce/quote identifiers as required by the captured schema).
- The signed payload to recover to the wallet address bound to the execution quote.

The adapter passes the persisted signer-operation ID as the Privy idempotency key, validates the 65-byte signature format, and independently recovers the signer address before returning the signature. The signature remains in memory only.

This is the policy/verification layer, not a connected Privy transport. The repository does not yet install @privy-io/node, configure an authorization context, or connect a Privy wallet. The tests have been authored but have not been executed in a local checkout.

## Implementation sequence

1. Capture and fixture-test a real Binance RFQ EIP-712 payload on BSC without signing or broadcasting.
2. Validate the domain, verifying contract, primary type, message field schema, wallet, tokens, exact input amount, nonce and expiry against the quote and RFQ order.
3. Implement a server-only Privy signTypedData adapter using the Node SDK authorization context and a stable signer-operation idempotency key.
4. Add policy tests that prove wrong chain, wrong verifying contract, wrong wallet, wrong tokens, excess amount, expired quote and unknown typed-data fields are rejected before Privy is called.
5. Wire the signer to the durable live-attempt ledger. Persist the signer operation ID before calling Privy; never persist raw signatures or typed data in the audit log.
6. Wire Binance submit/reconcile and independent BSC settlement verification. Unknown submissions must reuse the same request ID only within the provider's idempotency window.
7. Keep live execution disabled until the user has explicitly authorized the dedicated wallet and funding cap, and the end-to-end test suite has run.

## References

- Privy agentic wallets: https://docs.privy.io/recipes/agent-integrations/agentic-wallets
- Privy EVM typed-data signing: https://docs.privy.io/wallets/using-wallets/ethereum/sign-typed-data
- Privy server-side authorization context: https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server
- Privy EVM policy examples: https://docs.privy.io/controls/policies/example-policies/ethereum
- Privy chain support: https://docs.privy.io/wallets/overview/chains
- Privy Node SDK: https://www.npmjs.com/package/@privy-io/node
