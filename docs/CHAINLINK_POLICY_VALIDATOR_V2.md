# Chainlink-enforced policy validator V2

> V2 is the only supported policy contract; V1 has been removed from the repository. The V2 deployment previously configured at `0xed2fb17badc2bf45293c7cfd17996361c02db465` was constructed with a self-deployed `BNB / USD (TESTNET MOCK)` feed (always-fresh, guardian-controlled price) and predates the hardened hook (no policy-management pass-through; on-chain verification of delivered tokens). Redeploy before use.

## What changes

V2 is a new hook deployment. It does not modify the already deployed V1 contract. Every autonomous account must be migrated by its owner to V2 and its policy must be configured again.

V2 requires:
- A Chainlink BNB/USD feed fixed at deployment.
- A guardian-approved Chainlink token/USD feed for each target token.
- Positive, complete, fresh oracle rounds (maximum age is capped at 24 hours).
- A positive entry-price ceiling in micro-USD, plus per-account maximum slippage and price-impact BPS.
- A trade's signed slippage and impact fields no greater than the stored account limits.
- Oracle-derived minimum output no lower than conservatively rounded fair output reduced by the strictest of the signed trade slippage/impact and owner-stored slippage/impact limits.

Any missing, stale, negative, zero, incomplete, or unsupported oracle response rejects execution. A token without an approved USD feed cannot trade autonomously.

## BSC Testnet rollout

1. Verify the official Chainlink BNB/USD feed address for BSC Testnet from Chainlink's feed directory. Do not copy a mainnet feed address into testnet configuration.
2. Deploy with `pnpm deploy:testnet-policy` (defaults to the official proxy `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526`). The deployer becomes guardian. The script accepts only feeds pinned in `scripts/chainlinkFeeds.mjs` (a description string is not proof of authenticity), then validates decimals and a positive, complete, non-future round no older than one hour.
3. Record the deployed V2 address. Verify the contract bytecode, constructor feed, guardian, router, and EntryPoint on the explorer.
4. Set the application's `NEXT_PUBLIC_POLICY_HOOK_ADDRESS` to the new V2 deployment for the intended chain, then restart/redeploy the app. For each target token, configure its official Chainlink USD feed as guardian using:
   `npm run configure:testnet-token-feed -- <validator> <token> <chainlink-usd-feed> <max-age-seconds>`
   The command validates chain ID, validator/token/feed bytecode, a USD-quoted feed description, feed decimals, and current round freshness before sending the guardian transaction.
5. For each smart account, owner-authorize uninstalling the old V1 hook, install V2, and configure a fresh policy. V1 policy storage is not copied to V2.
6. Confirm `getAccountRiskPolicy`, `getAccountPolicy`, feed mappings, and freshness. Run Foundry tests and testnet buy/revert scenarios before considering live activation.

## Units and limits

- `entryPriceMicros`: USD per whole target token, multiplied by 1,000,000. Example: $100.00 is `100000000`.
- Feed answers are normalized to 18 decimals before comparison.
- Token decimals must be at most 18.
- Maximum slippage: 500 BPS; maximum price impact: 300 BPS.
- Feed max age: 60 to 86,400 seconds through the provided setup command and V2 contract.
- Trade value and rolling-volume caps remain unchanged from V1.

## Safety gates

This deployment script only targets BSC Testnet. Do not enable autonomous mainnet flags or point production accounts at V2 until contract compilation, the complete Foundry suite, testnet execution/revert tests, oracle-feed verification, and independent security review have passed. V2 is not deployed or activated by this code change.
