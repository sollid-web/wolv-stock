# WolvStock canonical architecture

One autonomous runtime, one owner per responsibility. Anything not listed here is either manual browser trading (unchanged) or historical (see `docs/history/`).

```mermaid
flowchart LR
    subgraph Browser["Frontend · Next.js 16 / React 19 (/agent)"]
        UI[AgentPolicyPanel + AgentSetupForm]
    end
    subgraph Owner["Owner wallet (EOA)"]
        OW[ECDSA owner key]
    end
    subgraph API["Execution API · Next.js route handlers"]
        SCH["/api/agent/schedules"]
        SES["/api/agent/session(+challenge)"]
        CTL["/api/agent/control (global stop)"]
    end
    DB[(PostgreSQL / Supabase<br/>schedules · claims · evidence · alerts · heartbeats)]
    subgraph Worker["Persistent worker (container)"]
        W[worker/agentWorker.ts<br/>claim → evaluate → execute → verify]
        AK[[AGENT_PRIVATE_KEY<br/>delegated signer only]]
    end
    subgraph Chain["BNB Smart Chain (97 first)"]
        K[Kernel v3.1 smart account<br/>root: ZeroDev ECDSA validator]
        PV[Agent permission validator<br/>agent ECDSA signer + TimestampPolicy (policy expiry)]
        H[TradingAgentPolicyValidatorV2 hook]
        CL[Chainlink BNB/USD + token/USD]
        R[PancakeSwap V2 router]
        EP[EntryPoint v0.7]
    end
    BND[ERC-4337 bundler]

    UI -- "1 installModule(hook) + setAccountPolicy (owner UserOps)" --> K
    OW -. signs once: policy UserOps, Kernel Enable typed data, session challenge .-> UI
    UI -- "2 strategy + enable signature" --> SCH
    SCH -- verify policy hash, owner, enable sig --> K
    SCH --> DB
    W -- "FOR UPDATE SKIP LOCKED claim" --> DB
    W -- read feed + reserves --> CL & R
    AK -. signs EIP-712 TradeIntent + UserOp .-> W
    W -- "UserOperation" --> BND --> EP --> K
    K -- validate via --> PV
    K -- "preCheck / postCheck" --> H
    H -- oracle floor, caps, signed intent --> CL
    K -- swap --> R
    W -- verified evidence --> DB
    CTL --> DB
```

## Responsibilities

| Layer | Canonical code | Owns | Must not |
|---|---|---|---|
| Frontend | `app/agent/page.tsx`, `components/AgentPolicyPanel.tsx`, `components/AgentSetupForm.tsx`, `lib/kernelClient.ts`, `lib/setupAgentPolicy.ts` | Owner onboarding, policy install/config, one-time agent authorization, schedule pause/resume, on-chain revoke, status | Execute trades or ask the owner to approve a trade |
| Agent permission definition | `lib/agentPermission.ts` (isomorphic) | The exact agent validator + hook pairing, its Kernel enable typed data, on-chain owner resolution, enable-signature verification | Touch private keys |
| Policy commitment | `lib/agentPolicyHash.ts` (`WOLV_AGENT_POLICY_V4`) | Binding owner, account, strategy, token, caps, expiry, signer and risk limits into the on-chain `policyHash` | — |
| Execution API | `app/api/agent/schedules/route.ts`, `session/*`, `control` | Authenticated schedule CRUD; verifies the on-chain policy, owner and enable signature before persisting | Hold `AGENT_PRIVATE_KEY`; bypass on-chain checks |
| Worker | `worker/agentWorker.ts` + `services/agentWorker.ts` (evaluation) | Heartbeat, lease expiry, atomic claims, trigger/risk evaluation, idempotent dispatch, outcome persistence, alerts | Run without the database; load owner keys; fall back to an owner-wallet transaction |
| Executor | `services/agentExecutor.ts` | Execution gates, validator preflight, re-quote, EIP-712 intent signing, UserOp submission, receipt + outcome verification | Report success from a receipt alone |
| Smart-account client | `lib/smartAccount.ts` (server-only) | Config, PancakeSwap quote/call encoding, Kernel client with pinned account address and on-chain owner check | Re-derive the account address |
| On-chain policy | `contracts/TradingAgentPolicyValidatorV2.sol` | Authoritative enforcement (see below) | — |
| Persistence | `services/agentMemoryStore.ts` (migrations v1–v12) | Schedules, claims, evidence, alerts, heartbeats, global control | Destructive migrations |

Off-chain checks (worker, executor, API) give early, explainable rejections. The V2 hook is authoritative: if they ever disagree, the transaction reverts.

## Smart-account lifecycle

1. **Account.** Kernel v3.1 (`kernel.advanced.v0.3.1`, implementation `0xBAC849bB…4b4D`), EntryPoint v0.7, root validator = ZeroDev ECDSA validator `0x845ADb2C…4cE57` (validation type `0x01`). The owner is read from `ecdsaValidatorStorage(account)`. It is never inferred from a deployer address or a locally derived address. The configured testnet account `0x08c35E16…502De` was verified to be exactly `KERNEL_V3_1` + ECDSA + owner `0xd9E7A9D6…eef0` + index 0.
2. **Hook install** (owner UserOp): `installModule(4, V2, 0x00‖abi(targetToken))`, which initializes hook state for the account.
3. **Policy** (owner UserOp): `setAccountPolicy(account, intentSigner, policyHash, maxTradeValue, expiresAt, entryPriceMicros, maxSlippageBps, maxPriceImpactBps)`. The UI reads it back and compares it.
4. **Agent authorization** (owner signature, once): Kernel `Enable` typed data for the agent permission validator (agent signer + TimestampPolicy bound to the on-chain policy expiry) paired with the V2 hook. It is bound to the account, chain and Kernel validator nonce.
5. **First autonomous trade** runs in Kernel enable mode and installs the agent validator using that signature. Every later trade uses the installed validator. No owner involvement.
6. **Revocation:** owner `revokeAccount` (terminal for the hook) or uninstall; guardian `setPaused(true)` stops every account; schedule pause stops future cycles.

## Execution lifecycle (per due schedule)

1. Worker heartbeat; abort if gates are off, the global control is stopped, or the owner's time-boxed release has expired.
2. Expire `CLAIMED` leases older than 5 minutes (never-submitted runs only).
3. Atomically claim due `BSC_AGENT_TRADE` schedules with no active claim (`FOR UPDATE SKIP LOCKED`), plus a unique `(owner, run_key)` claim row.
4. Validate the stored strategy and V4 policy hash against on-chain policy state.
5. Market data: guardian-allowlisted Chainlink token/USD feed (freshness, completeness, decimals) and live PancakeSwap V2 reserves.
6. Evaluate trigger (oracle price ≤ entry ceiling), price impact, slippage and rolling caps.
7. Executor: gates → validator preflight (installed, not revoked/paused, policy hash, signer, risk limits, expiry, rolling volume) → re-quote → random 256-bit intent nonce → agent signs EIP-712 `TradeIntent` → UserOp via bundler.
8. On-chain: permission validator (agent key, TimestampPolicy; Kernel forces `executeUserOp` for hooked validators) → hook `preCheck` (route, recipient, signed intent, nonce replay, deadline ≤15 s, caps, Chainlink oracle floor) → swap → `postCheck` (actual balance delta ≥ `amountOutMin`).
9. Verify: hook `AgentExecutionSucceeded` for this account, target-token `Transfer` logs to the account ≥ minimum, balance increase ≥ minimum. Persist `CONFIRMED` with evidence.
10. Any failure after submission is **uncertain**: the claim becomes `STOPPED`, the schedule is disabled, and a CRITICAL alert is raised. Nothing resubmits automatically.

## What V2 enforces on-chain

Caller is EntryPoint · hook installed and not revoked · global pause · router and `swapExactETHForTokens` only · path `[WBNB, targetToken]` · recipient is the account · value > 0 and ≤ policy cap (≤ 0.5 BNB) · rolling 7-day volume ≤ 1 BNB, ≤ 128 active trades · policy configured and unexpired · intent policy hash matches · intent signed by the configured intent signer (low-s, v∈{27,28}) · intent nonce unused · `validUntil` ≤ policy expiry · deadline ≤ 15 s and ≤ `validUntil` · signed slippage/impact within stored limits · fresh, complete, positive Chainlink BNB/USD and token/USD rounds · oracle token price ≤ entry ceiling · `amountOutMin` ≥ oracle-fair output less the strictest tolerance · **actual tokens received ≥ `amountOutMin`**.

Not enforced on-chain (off-chain only): strategy evaluation interval, the "buy below threshold" trigger timing, and the target token's legitimacy beyond the guardian's feed allowlist.

## Security boundaries

- The owner key never leaves the owner's wallet. The worker builds the owner validator from a public address; it cannot sign.
- `AGENT_PRIVATE_KEY` exists only in the worker's secret store. The web tier verifies against `NEXT_PUBLIC_AGENT_SIGNER_ADDRESS`.
- Kernel restricts the agent validator to `execute` and forces every agent UserOperation through `executeUserOp`, i.e. through the V2 hook, which allows only single-call `swapExactETHForTokens` on the approved router, WBNB→target, recipient = account, ≤ the owner's cap (≤0.5 BNB). ZeroDev CallPolicy is not used because it cannot parse `executeUserOp`. The hook has no pass-through for policy management.
- The guardian (V2 deployer) can only pause globally and manage the Chainlink feed allowlist. It cannot move funds or change account policies. Feed changes are a trust assumption: guardian scripts accept only pinned official Chainlink proxies (`scripts/chainlinkFeeds.mjs`).
- Mainnet requires two additional explicit flags; the deploy and feed scripts are testnet-only.

## Deployment topology

- **Web/API:** Vercel (`fra1`), stateless. It never runs the trading loop.
- **Worker:** one always-on container (`Dockerfile.agent-worker`) with restart-on-failure; scale out only after concurrent-claim behavior is verified on a staging database.
- **Database:** PostgreSQL reachable by both, with a dedicated restricted role. Test and production must be separate projects.
- **Chain access:** RPC plus a Pimlico-compatible EntryPoint v0.7 bundler.
