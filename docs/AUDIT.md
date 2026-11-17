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
| 4 | **High** | V2 `preCheck` passed through `setAccountPolicy` calls. Because the hook is paired only with the agent validator, the agent key could rewrite its own policy if the agent permission were ever misconfigured. | **Fixed** (pass-through removed; test added) |
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
| 1–2 | Connect wallet; identify smart account | Implemented; `/agent` refuses a wallet that is not the on-chain ECDSA owner |
| 3–5 | Owner installs hook + sets policy; read back on-chain | Implemented; nonce-safe against lagging RPCs; hook must use the official Chainlink BNB/USD feed |
| 6 | One-time agent authorization (Kernel enable signature) | Implemented; verified against on-chain owner; **Re-authorize agent** re-signs from the saved schedule |
| 7 | Persist strategy (verified against chain) | Implemented |
| 8–11 | Worker claims, reads Chainlink + reserves, evaluates trigger/risk | Implemented; **verified live on chain 97** |
| 12–13 | Agent signs EIP-712 intent; UserOp via bundler (enable mode first) | **Verified live on chain 97** |
| 14–16 | Permission validator (TimestampPolicy) + V2 hook; swap | **Verified live on chain 97** |
| 17–18 | Outcome verification; evidence in DB; reschedule | **Verified live on chain 97** |
| 19 | Frontend reflects state | Schedule, claim, heartbeat, global stop/release shown; per-trade history view not yet built |

### Permission design change (2026-11-17, owner-approved)

ZeroDev CallPolicy (every version up to V0_0_5) cannot parse Kernel v3.1's `executeUserOp` wrapper, which Kernel **forces** for any validator paired with a hook (a plain `execute` reverts with `InvalidValidator()`, verified by trace). With CallPolicy + hook every agent UserOperation reverted in `validateUserOp`. The agent permission now uses **TimestampPolicy** (validUntil = on-chain policy expiry) and the V2 hook is the enforced call allowlist: single-call mode, exact calldata, approved router, `swapExactETHForTokens`, WBNB→target path, recipient = account, value ≤ owner cap (≤ 0.5 BNB), signed intent, nonce, deadline, rolling caps, Chainlink oracle floor, delivered amount. Kernel also restricts the validator to the `execute` selector.

## 5. Test report (2026-11-17, HEAD of `autonomy/onchain-agent-runtime`)

| Check | Command | Result |
|---|---|---|
| TypeScript | `pnpm exec tsc --noEmit` | **Pass** |
| Logic tests | `pnpm test:logic` | **237 pass, 0 fail, 1 skipped** (live Binance provider; needs an API key) |
| Lint | `pnpm lint` | **0 errors, 6 warnings** (pre-existing) |
| Clean install + production build | fresh `git archive HEAD`, pnpm 9.15.9 `install --frozen-lockfile` + `build` | **Pass** (required the `pnpm-workspace.yaml` packages fix) |
| Foundry | `forge test` | **25/25 pass** (+7 on-chain negative paths) |
| PostgreSQL integration | `pnpm test:postgres` on a disposable local DB | **6/6 pass**, incl. two-worker claim race and evidence shape |
| Slither | `slither contracts/TradingAgentPolicyValidatorV2.sol` | **0 high, 3 medium** (triaged below), 6 low (timestamp), informational. *The earlier "0 medium" statement was wrong.* |
| Fork rehearsal | `scripts/fork-agent-e2e.mjs` (anvil fork, real executor) | **Pass**: enable-mode trade, then trade with no owner signature |
| Live testnet acceptance | worker container on chain 97 | **Pass** (§7) |

Slither medium triage: `locked-ether`: payable hook entry points revert on any value (required by ERC-7579 signatures); no ETH can be locked. `unused-return`: `startedAt` from `latestRoundData` is intentionally unused; round id, answer, updatedAt, answeredInRound are checked. `divide-before-multiply` in `_calculateOracleMinimumOut`: `fairOut` is rounded **up** before applying tolerance, which makes the oracle floor stricter, never looser. None is exploitable in our review; an independent review is still required before mainnet.

## 6. Open decisions

- **Phase 4.0 proposal/orchestrator plane** (`/api/agent/{policy,proposals,run}`, `agentOrchestrator`, `agentAnalysis`, `marketDataCollector`, `binanceAgentMarketAdapter`). It is a human-in-the-loop proposal system that ends at `EXECUTION_BLOCKED`, disabled by default and unused by the UI. Its `/api/agent/control` STOP is the global stop the worker honors. Recommendation: keep `control`, remove the proposal plane. That is a product decision (the `audit/agentic-autonomous-reconciliation` branch argued for human approval), so it was left in place.
- `upstream/autonomy/rebuild-from-hackathon-baseline` (Privy/RFQ): recommend archiving rather than merging.

## 7. Testnet end-to-end acceptance (BSC testnet, chain 97)

| Item | Value |
|---|---|
| V2 policy hook | `0x3399a924138f8782facd94f2e779a276e5084a26` (deploy tx `0x2c8f3e44…86d1`, block 143184261; ETH/USD feed tx `0x725c7756…22ea`) |
| Smart account / owner / agent signer | `0x08c35E16…02De` / `0xd9E7A9D6…eef0` / `0x0277B986…Db98` |
| Hook install (owner UserOp) | UserOp `0x06639554…a806`, tx `0x7146fd7d498751eb4c9d7a7afe5573f547bb89e57bfd012610afe8dd12d8f7c1`, block 143244229 |
| Policy set (owner UserOp) | UserOp `0xabcff76e…3f80`, tx `0xaf695803c558c23c6f8c0b4c26089dbbe854d1c7b7fe85d28eb104ce19018f34` |
| **Autonomous trade 1** (enable mode, owner's one-time signature) | UserOp `0x199bfac6a5caad4299cdfd57e9058ef67898e3b3bbf0f26a432f3085d18bdaab`, tx `0xf1187937037d3d0c63a01b590c5dbe674c9b937cb64b83531a8969bd17d6b7d6`, block 143264903. 0.001 BNB → 0.000450041711401365 ETH (min 0.000445095…). Events: `ModuleInstalled` (hook, TimestampPolicy, ECDSA signer), ETH `Transfer` pair→account, `AgentExecutionSucceeded`, `UserOperationEvent success=true` |
| **Autonomous trade 2** (no owner signature) | UserOp `0x560b8d7e70886381dce948e21b62fc369139a4d28b449df1c249f75fe1bc95a9`, tx `0x0909f8146931196593b48a2d4ccb916a2cd5819342288c42a5108b4e24af1437`, block 143265066. Received 0.000449283842976807 ETH; balance 0 → 0.000899325554378172 ETH |
| DB evidence | 2 claims `CONFIRMED` with `execution_evidence` (tx hash, block, amounts, balances); schedule rescheduled |
| Worker | Docker `wolv-agent-worker-testnet` (`--restart unless-stopped`), heartbeat in `wolv_agent_worker_heartbeats` |

Negative paths: hook (Foundry) rejects unauthorized signer, above-cap, expired policy, guardian pause, revoked account, unapproved token, non-EntryPoint caller, stale/invalid oracle, oracle floor, entry ceiling, replay, under-delivery. Executor/worker unit tests: gates off, live submission off, mainnet blocked without separate flags, paused/revoked/uninstalled, policy hash/owner/token/strategy drift, price impact, stale market data, overlapping cycles. PostgreSQL: two-worker race yields one claim; paused schedules never claimed. Live: global emergency stop paused the running worker immediately; an expired global release now fails closed (fixed this session).

Testnet DB: local Docker Postgres (`wolv-testnet-pg`, `127.0.0.1:55432`); the Supabase project remains production-only. Local config: `.env.testnet.local`, `.env.development.local`, `.env.worker.testnet.docker` (all gitignored).

## 8. Production readiness

**Testnet:** autonomous execution verified end to end (§7).

**Mainnet: NOT READY.** Blockers and the action for each:

1. Independent security review of V2 and of the Kernel enable/hook/TimestampPolicy interaction.
2. Mainnet V2 deployment + source verification, and a pinned mainnet Chainlink feed allowlist (scripts are testnet-only by design).
3. Production DB: dedicated restricted role, backups, TLS (`verify-full` is enforced when `NODE_ENV=production`).
4. Persistent production worker host (container with restart policy) + secrets in the host's secret store.
5. Paging on missing heartbeats and CRITICAL alerts (currently stored, not paged).
6. Bundler/RPC failover (single provider each today).
7. Gas-funding policy for the smart account (no paymaster; each enable-mode trade ≈ 0.00033 tBNB gas).
8. Global-stop release is capped at 30 minutes by the control API: product decision whether unattended operation should allow longer leases (on-chain expiry and caps remain authoritative).
9. Mainnet flags `ENABLE_MAINNET_AGENT_TRADING` / `MAINNET_AGENT_TRADING_ACK` stay unset until 1–8 are done and the owner explicitly authorizes.
