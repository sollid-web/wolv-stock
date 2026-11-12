# RFQ Signer Acceptance Plan — WOLV

**Decision status:** Privy is a viable signer candidate, not an approved or connected signer.
**Target:** Binance Web3 Aggregator RFQ EIP-712 orders on BNB Smart Chain (chain ID 56).
**Execution status:** paper-only. This document does not authorize wallet creation, import, funding, signing, submission, or deployment.

## Why a separate signer is required

The Binance Web3 API authenticates WOLV's API requests. It does not authorize the API to sign for the wallet supplied to the RFQ quote endpoint. The RFQ `/swap` response supplies an EIP-712 payload that must be signed by the same wallet address used for the quote, then submitted through Binance's RFQ order endpoint.

WOLV's current adapter validates and hashes the unsigned payload, but intentionally does not sign it. The current parser accepts either:
- `JSON_TYPED_DATA`: JSON containing `domain`, `types`, `primaryType`, and `message`.
- `HEX_EIP712_PAYLOAD`: opaque hex bytes whose semantic fields are not decoded by the current implementation.

**A hex payload must not be passed to an EIP-712 JSON signing method.** The exact Binance payload encoding and field semantics must be established from a real, read-only build response before implementing a signing adapter.

## Candidate: Privy server wallet / delegated signer

Privy's wallet infrastructure documents:
- EVM typed-data signing via `eth_signTypedData_v4`.
- Server-side authorization keys and configurable signer ownership/quorums.
- Policy rules for typed-data domain and message fields, with deny rules taking precedence.
- Default-deny policy behavior for actions not explicitly allowed.

This makes Privy technically promising for a bounded WOLV trading wallet. It is not a drop-in extension of WOLV's existing Reown/Wagmi connection. The exact wallet address used for Binance RFQ must be controlled by the Privy wallet or by an explicitly authorized signer for that same wallet. A newly created Privy wallet would have a different address and must not silently replace a user's existing wallet.

No Privy package, credentials, wallet, authorization key, policy, signer, or custody migration is added by this plan. The application must not create/import/fund a wallet without explicit user authorization.

## Required signing boundary

The production adapter must implement the existing `TypedDataSigner` contract and must:
1. Accept only an owner-scoped, enabled signer connection.
2. Require chain ID 56 and exact equality between the requested wallet and the configured signer wallet.
3. Verify the payload hash equals the immutable `typedDataHash` recorded when Binance's RFQ order was built.
4. Accept only the verified Binance typed-data format. Reject opaque hex until its exact binary schema is decoded and independently tested.
5. Validate EIP-712 domain, primary type, verifying contract, token addresses, amounts, order ID/nonce, expiry and any spender/approval authority against the quote and order evidence. Unknown or additional authority-bearing fields must fail closed.
6. Enforce a wallet-level default-deny policy, including chain, verifying-contract and typed-data message constraints. WOLV's application risk engine is an additional layer, not a substitute for signer policy.
7. Return a signature only if the signer address equals the exact wallet used in the RFQ quote.
8. Never log or persist raw typed data, signatures, authorization credentials or private key material. Persist only hashes, provider request IDs, signer identity metadata and outcome.
9. Apply idempotency to the subsequent Binance submit request. A timeout or ambiguous response must enter reconciliation; it must not trigger a second signature/submission with a new request ID.
10. Stop immediately on signer revocation, authorization failure, policy mismatch, expired quote, stale intent version or emergency stop.

## Read-only schema capture

A local read-only probe now builds a real Binance quote and unsigned RFQ order, then prints only the schema metadata needed for signer review. It never prints raw typed data, signs, submits or broadcasts.

```bash
npm run autonomy:rfq-schema-probe -- --wallet 0x... --input-token 0x... --output-token 0x... --amount 1000000
```

The probe can also read the wallet/input token/amount from the existing WOLV autonomy environment variables and the output token from `WOLV_AUTONOMY_PROBE_OUTPUT_TOKEN_ADDRESS`. It requires local server-side Binance API credentials in `.env.local` or `.env`. Do not paste credentials or raw typed data into chat. The safe JSON output contains the quote/order IDs, typed-data format/hash, domain metadata, primary type, field names/types, transaction-like field names, calldata/nonce/expiry presence indicators and approval metadata. If the format is opaque hex, the probe marks it unsupported by the current signing policy.

## RFQ simulation gate — unresolved

The current WOLV RFQ path builds an unsigned EIP-712 order and later submits the signature to Binance. An EIP-712 message is not itself an EVM transaction, so the ordinary BSC eth_call/eth_estimateGas simulator cannot safely simulate it unless the vendor payload exposes a complete, exact EVM transaction envelope.

The safe RFQ schema probe now reports transaction-like message field names and boolean indicators for calldata, nonce and expiry fields without exposing their values. This helps determine whether the order schema contains a simulation-ready transaction description.

Before enabling live entry, one of these must be verified:
- Binance documents and provides an RFQ-specific preview/simulation endpoint for the exact RWA vendor route; or
- the signed RFQ order can be deterministically converted into a complete EVM transaction, including exact sender, target, calldata and native value, and that exact transaction can be simulated before submission.

Do not substitute an unrelated provider's simulation endpoint. For example, the OnchainOS pre-transaction simulation API is an OKX product, not a Binance RFQ simulator. Do not call it with Binance payloads or represent its result as Binance execution evidence.

Until this gate is satisfied, the live-entry orchestrator rejects missing simulation evidence and the live worker remains disabled. The reconciliation-only worker is unaffected: it verifies transactions that Binance has already submitted.

## Required evidence before enabling a signer

- [ ] Capture a real Binance RFQ build response in the user's environment without printing secrets or raw typed data into logs.
- [ ] Determine whether Binance returns JSON typed data or opaque hex for the target RWA vendor.
- [ ] Obtain the official Binance typed-data schema/domain contract for that exact RFQ route.
- [ ] Confirm the EIP-712 domain chain ID, verifying contract, primary type and every authority-bearing field.
- [ ] Verify the typed-data digest independently against a second implementation.
- [ ] Verify a signature recovers to the exact wallet address used in the quote.
- [ ] Verify Privy's server-wallet API supports the needed signing operation and the selected BSC chain.
- [ ] Configure wallet policy with explicit allow rules and deny-by-default behavior; test negative cases.
- [ ] Test signer revocation, authorization-key rotation, provider outage, timeout and worker restart.
- [ ] Prove Binance accepts the signature and returns an order status that can be reconciled.
- [ ] Verify successful BSC receipt and token balance deltas before classifying an order as settled.
- [ ] Complete a dedicated low-value pilot only after explicit owner authorization and independent risk review.

## Do not do

- Do not import a connected Reown wallet's private key into a server.
- Do not assume a browser-connected wallet can sign while the browser is closed.
- Do not create a Privy wallet and silently change the RFQ wallet address.
- Do not pass a hex payload to `eth_signTypedData_v4`.
- Do not sign a payload based only on a matching SHA-256 hash; semantic fields and domain must also be checked.
- Do not let an LLM construct or alter signer policy, spend limits, allowlists or typed data.
- Do not treat a signature, Binance order ID or API success response as settlement.

## References

- Privy wallet policies and controls: https://docs.privy.io/security/wallet-infrastructure/policy-and-controls
- Privy EVM typed-data policy condition types: https://app.unpkg.com/@privy-io/api-types@0.4.0/files/resources/policies.d.mts
- Privy Node SDK and delegated signer guide: https://docs.privy.io/recipes/bankr-bot-guide
- EIP-712 specification: https://eips.ethereum.org/EIPS/eip-712
- Binance Agentic Wallet external signing flow (explicit confirmation path; not selected for unattended RFQ): https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md
