# WolvStock consolidation audit — 2026-11-17

Branch: `autonomy/onchain-agent-runtime`. Canonical design: [ARCHITECTURE.md](./ARCHITECTURE.md). Testnet procedure: [agent-worker-deployment.md](./agent-worker-deployment.md).

## 1. Branch comparison

| Branch | Relation to `autonomy/onchain-agent-runtime` | Content | Decision |
|---|---|---|---|
| `main` (local and `upstream/main`, 55f8633) | Strict ancestor (0 commits not in autonomy; autonomy is +226) | Hackathon terminal, then Phase 3–4 hardening, BAW CLI, DCA/RFQ/weekend-DeFi, ZeroDev session-plan, first worker | Preserved untouched. Everything worth keeping already flows into autonomy |
| `ef67f62` (baseline, 2026-10-09) | Ancestor of both | Original manual wallet-connected terminal | Manual trading retained as is |
| `upstream/autonomy/rebuild-from-hackathon-baseline` (427f378) | Diverged at `ef67f62`; +647 / −258 | Separate Privy server-wallet + Binance RFQ live-entry orchestrator | **Competing architecture.** Not merged. Its execution model (custodial Privy signer, Binance RFQ) conflicts with the owner-controlled smart-account design |
| `upstream/audit/agentic-autonomous-reconciliation` | +4 docs on top of main | Recommends prioritizing the manual trading experience | Docs only; superseded by this audit |
| `upstream/feat/wolv-glassmorphic-terminal` | +1 on an old base | UI theme | Out of scope |
| `backup/upstream-main-20260930` | Ancestor | Backup | Leave |

Git merge status alone is misleading here. `main` "merges cleanly" because it adds nothing, but `main` itself carries several non-executing agent implementations, removed below.

## 2. Findings (ranked)

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | The autonomous path could never execute: the worker's Kernel plugin manager needs the owner to sign the agent validator's `Enable` data at the first UserOp, but the owner validator is address-only and nothing ever collected that signature. | **Fixed.** One-time owner enable signature collected in `/agent`, verified by the API against on-chain owner/nonce, replayed by the worker (`lib/agentPermission.ts`) |
| 2 | **Critical** | Deployed V2 (`0xed2f…b465`) uses a self-deployed `BNB / USD (TESTNET MOCK)` feed whose `updatedAt` is always `now` and whose price the guardian sets ($870.96 vs Chainlink $592.84). Oracle and staleness protection are void. The deploy script's description regex accepted it. | **Fixed in code** (pinned official Chainlink proxies). **Redeploy required** |
| 3 | **High** | Success was declared from `receipt.success` alone; no swap-outcome verification. | **Fixed.** Hook success event + Transfer logs + balance delta required; evidence persisted. V2 `postCheck` now verifies delivered tokens on-chain |
| 4 | **High** | V2 `preCheck` passed through `setAccountPolicy` calls. Because the hook is paired only with the agent validator, the agent key could rewrite its own policy if the CallPolicy were ever misconfigured. | **Fixed** (pass-through removed; test added) |
| 5 | **High** | Configured `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS` is WBNB, so the swap path `[WBNB, WBNB]` has no pool. | **Fixed** (startup rejects WBNB). **Local `.env*` must be changed by you** |
| 6 | **High** | Web API loaded `AGENT_PRIVATE_KEY` to compare addresses. | **Fixed** (public `NEXT_PUBLIC_AGENT_SIGNER_ADDRESS`) |
| 7 | **High** | `TEST_POSTGRES_URL` and `WOLV_AGENT_DATABASE_URL` point to the same Supabase project/database as the app. | **Open.** Create a separate test project. Integration tests were not run against it |
| 8 | Medium | Account identity: the earlier "SECONDARY validator / different derived address" concern. | **Resolved by on-chain read.** Root `0x01‖0x845ADb2C…` is the standard ZeroDev ECDSA validator (`0x01` = `VALIDATION_TYPE_VALIDATOR`). Owner `0xd9E7A9D6…eef0`; `KERNEL_V3_1` index 0 derives exactly `0x08c35E16…502De`. The earlier mismatch came from deriving with a different signer. The account is compatible; no new account is needed |
| 9 | Medium | Static worker mode (`AGENT_STRATEGIES_JSON`) had no durable claims or idempotency; env-driven `import()` adapters allowed arbitrary code loading. | **Fixed** (removed) |
| 10 | Medium | A crashed worker left `CLAIMED` rows blocking a schedule forever. | **Fixed** (5-min lease expiry for never-submitted claims; `SUBMITTED` stays locked) |
| 11 | Medium | Account address was re-derived from owner + index on every run. | **Fixed** (pinned `address`, on-chain owner re-checked) |
| 12 | Medium | V1 policy on the account has intent signer `0x288f…bE93`, which is not the configured agent `0x0277…Db98`; V2 is not installed. | Informational. V2 install + policy happens in the runbook |
| 13 | Low | `.env.example` router `0x9Ac6…` differs from the router the hook was deployed with (`0xD99D…`). `/usr/bin/forge` on this host is an unrelated program (ZOE) and breaks Slither. | Fixed / documented |
| 14 | Info | Brief assumed a Hono execution API, `permissionless`, and a public MCP server. None exist: the API is Next.js route handlers; `.agents/skills` are vendored third-party coding-agent skills. | No new framework added |

## 3. Canonical components and cleanup

Retained (one per responsibility): see the table in ARCHITECTURE.md. Also retained: manual browser trading (`/api/quote`, `swap`, `approve-transaction`, `order/*`, `transaction*`, `TradeButton`), market/RWA discovery, wallet-session auth, BSC metadata/RPC diagnostic tooling, and the Phase 4.0 control plane (see §6).

Removed (commit `2f23027` and `67b4b38`):

| Removed | Reason |
|---|---|
| `/api/agent/worker`, `/strategies/weekend-defi`, `/api/defi/*`, `dcaExecutor`, `recurringIntentService`, `rfqOrderService`, `weekendDefiRebalancer`, `weekendDefiRoutes`, `usMarketCalendar` | Second "agent runtime", typed `transactionSubmitted: false`; never executed |
| `/api/agent/intents`, `policyIntent` | Per-trade owner signatures, the anti-pattern being replaced |
| `/api/agent/session-plan`, `/api/agent/dynamic`, `dynamicStrategy*` | Hard-coded simulation-only / MONITOR-PROPOSE |
| `/api/agent/{approve,execute,executions,quote,simulation,wallet,autonomous,status}`, `baw{Cli,Quote,QuoteHttp,Asset,Execution,ExecutionHttp}`, `bscTokenMetadata`, `agentTransactionSimulation`, `autonomousTradingGate`, `agentStrategies`, `agentTelemetry` | 403 stubs / BAW CLI path reachable only from orphaned UI |
| `AgentTerminal`, `AgentWalletPanel`, `OpportunitySpotlight`, `Web3StrategyShowcase` (+3 preview cards) | Unreferenced or static preview |
| `executeAgentBuy` / `runAgentExecutionWithTelemetry` | Duplicate executor that sent unsigned calls the hook rejects |
| `TradingAgentPolicyValidator.sol` (V1) + tests + forge script, `WOLVAdvancedStrategyVault.sol` | Superseded / unreferenced |
| `lib/publicAssets`, `lib/trades`, `scripts/injectTestStrategy.js` | Unused / DCA diagnostic |
| Deps `@bnbagent/sdk`, `@x402/*` (4), `ethers`, `ioredis`, `lightweight-charts` | No imports |
| Tracked `cache/`; Phase 3/4 reports moved to `docs/history/` | Build artifact / historical |

Kept deliberately: `@react-native-async-storage/async-storage` and `@walletconnect/ethereum-provider` (indirect wallet-connector peers). Database tables of removed features are untouched; the only migration added is additive (v12 `execution_evidence jsonb`).

## 4. Autonomous execution stages

| # | Stage | State |
|---|---|---|
| 1–2 | Connect wallet; identify smart account | Implemented; owner verified from chain |
| 3–5 | Configure policy; owner installs hook + sets policy; read back on-chain | Implemented (existing UI) |
| 6 | One-time agent authorization | **Implemented in this change** |
| 7 | Persist strategy (verified against chain) | Implemented |
| 8–11 | Worker discovers, reads Chainlink + reserves, evaluates trigger/risk | Implemented |
| 12–13 | Agent signs EIP-712 intent; UserOp via bundler (enable mode first) | Implemented; **not yet exercised on-chain** |
| 14–16 | Permission validator + V2 hook checks; swap | Contract unit-tested; **needs redeploy + live run** |
| 17–18 | Outcome verification; evidence in DB | **Implemented in this change**; unit-tested |
| 19 | Frontend reflects state | Schedule/claim/heartbeat status shown; per-trade evidence history view not yet built |

## 5. Test report (this session, after all changes)

| Check | Command | Result |
|---|---|---|
| TypeScript | `pnpm exec tsc --noEmit` | **Pass** (after a fresh build regenerates `.next/types`) |
| Logic tests | `pnpm test:logic` | **236 pass, 0 fail, 1 skipped** (`real Binance provider…`, needs a live API key). Down from 463 because ~230 tests covered removed modules. +6 new outcome-verification tests |
| Lint | `pnpm lint` | **0 errors, 6 warnings** (pre-existing, unrelated files) |
| Production build | `pnpm build` | **Pass**, no warnings |
| Foundry | `forge test` | **18/18 pass** (V2; +3 new). V1 suites removed with V1 |
| Slither | `slither . --fail-high` | **0 high / 0 medium**; info only (intentional round-up, false-positive locked-ether) |
| Worker image | `docker build -f Dockerfile.agent-worker` (pnpm 9.15.9, frozen lockfile) | **Pass**; container fails closed without DB and with WBNB target |
| Live chain reads | Account, owner, validators, feeds, pools, enable typed data | **Pass** (read-only) |
| `test:postgres` | — | **Not run**: test DB is the production DB (finding 7) |
| `test:responsive`, `test:provider` | — | **Not run** (need a running server / live Binance keys) |
| Kernel enable-mode UserOp, session-key execution, real swap | — | **Not run**: blocked (§7) |

## 6. Open decisions

- **Phase 4.0 proposal/orchestrator plane** (`/api/agent/{policy,proposals,run}`, `agentOrchestrator`, `agentAnalysis`, `marketDataCollector`, `binanceAgentMarketAdapter`). It is a human-in-the-loop proposal system that ends at `EXECUTION_BLOCKED`, disabled by default and unused by the UI. Its `/api/agent/control` STOP is the global stop the worker honors. Recommendation: keep `control`, remove the proposal plane. That is a product decision (the `audit/agentic-autonomous-reconciliation` branch argued for human approval), so it was left in place.
- `upstream/autonomy/rebuild-from-hackathon-baseline` (Privy/RFQ): recommend archiving rather than merging.

## 7. Testnet end-to-end: blocked, with exact steps

No UserOperation, transaction, deployment, or configuration change was made on any chain in this session. **There is no testnet execution evidence yet**: no UserOp hash, transaction hash, balance change or DB record. Blockers, each requiring something only you hold:

1. **Guardian/deployer key** (`DEPLOYER_PRIVATE_KEY`, not present in the environment): `pnpm deploy:testnet-policy`, then `pnpm configure:testnet-token-feed -- <newV2> 0xd66c6B4F0be8CE5b39D52E0Fd1344c389929B378 0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7 86400`.
   - ETH testnet pool currently pays ~1.37× oracle-fair output, so it passes the oracle floor; USDT/DAI pools do not.
2. **Owner wallet `0xd9E7A9D6…eef0`**: set `NEXT_PUBLIC_POLICY_HOOK_ADDRESS=<newV2>` and `NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS=0xd66c…B378`, then in `/agent` install the hook, set the policy (intent signer `0x0277B986…Db98`, e.g. amount 0.001 BNB, entry ceiling above the ETH/USD price), save, and sign the one-time authorization.
3. **Separate test database** for `WOLV_AGENT_DATABASE_URL` on the worker (finding 7).
4. Start the worker with `WOLV_AUTONOMOUS_TRADING_ENABLED=true ENABLE_LIVE_USEROP_SUBMISSION=true`, chain 97. The smart account holds 0.0499 tBNB, which is enough for a 0.001 BNB trade plus gas.

Acceptance is the checklist in the deployment guide: the claim reaches `CONFIRMED` with `execution_evidence`, the hook event is present, and the explorer shows the ETH balance increase, followed by the negative paths (pause, revoke, expiry, stale feed).

## 8. Production readiness

**Testnet:** code-complete for one end-to-end run; blocked on the three items in §7.

**Mainnet: not ready.** Remaining blockers:

- No verified testnet execution, and no negative-path acceptance on testnet.
- No independent security review of V2 or of the Kernel enable/hook interaction.
- Deploy/feed scripts are testnet-only by design; mainnet feeds need their own pinned allowlist.
- Separate production and test databases, a restricted DB role, backups.
- Worker monitoring and alerting on missing heartbeats and CRITICAL alerts (currently stored, not paged).
- Single-worker operation until concurrent claims are verified on staging.
- Bundler/RPC failover: one endpoint each today; receipt timeouts correctly lock the schedule, but there is no secondary provider.
- Paymaster or gas-funding policy for the smart account.
- A frontend history view of per-trade evidence.
