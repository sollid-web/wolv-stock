import { startMarketPulseRefresher } from "../lib/marketPulseRefresher.ts"
import { createAlertNotifier } from "../lib/alertNotifier.ts"
import { pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { AgentSmartAccountConfig } from "../lib/smartAccount.ts"
import {
    createAgentPublicClient,
    getAgentSmartAccountConfig
} from "../lib/smartAccount.ts"
import { createOwnerValidatorFromAddress } from "../lib/agentPermission.ts"
import {
    AgentExecutor,
    createWorkerFailureReporter,
    resolveAgentExecutionNetwork
} from "../services/agentExecutor.ts"
import {
    AgentWorker,
    createViemValidatorReader,
    MAX_TRADE_BNB,
    type AgentStrategy,
    type AgentCycleTelemetry
} from "../services/agentWorker.ts"
import { closeIntentNonceTracker } from "../services/agentIntentNonceTracker.ts"
import { AgentMemoryStore } from "../services/agentMemoryStore.ts"
import { loadWorkerEnvironment } from "./workerEnvironment.ts"
import { fetchMarketData } from "../services/agentMarketData.ts"
import {
    getAddress,
    isAddress,
    parseEther,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

const POLL_INTERVAL_MS = 5_000
const QUOTE_SUBMISSION_BUDGET_MS = 15_000
/** A CLAIMED (never submitted) schedule run older than this is released as LEASE_EXPIRED. */
const EXECUTION_LEASE_MS = 5 * 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function loadPrivateKey() {
    const key = process.env.AGENT_PRIVATE_KEY
    if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) {
        throw new Error("AGENT_PRIVATE_KEY must be a dedicated 32-byte agent signer key.")
    }
    return privateKeyToAccount(key as `0x${string}`)
}

/**
 * Market data comes from the same guardian-allowlisted Chainlink feed the V2 hook enforces
 * on-chain, plus live PancakeSwap reserves. Off-chain evaluation therefore cannot disagree with
 * the contract about price; the contract remains authoritative.
 */

type ActiveScheduleClaim = {
    claimId: string
    scheduleId: string
    ownerAddress: string
    status: "CLAIMED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "STOPPED"
    userOperationHash?: string
    submissionUpdate?: Promise<void>
}

type PersistentScheduleContext = {
    activeClaim: ActiveScheduleClaim | null
    lastTelemetry: AgentCycleTelemetry | null
    panicStopped: boolean
}

type PersistentScheduleRuntime = {
    configHash: string
    worker: AgentWorker
    context: PersistentScheduleContext
}

function getLastTelemetry(context: PersistentScheduleContext): AgentCycleTelemetry | null {
    return context.lastTelemetry
}

type StoredStrategy = { strategy: AgentStrategy; sessionEnableSignature?: Hex }

function parseStoredStrategy(value: unknown, config: AgentSmartAccountConfig, expectedOwnerAddress: string): StoredStrategy {
    if (!isRecord(value)) throw new Error("Persisted strategy configuration must be an object.")
    const { id, ownerAddress, account, targetToken, amountBnb, entryPriceMicros, slippageBps, maxPriceImpactBps, sessionEnableSignature } = value
    if (sessionEnableSignature !== undefined &&
        (typeof sessionEnableSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sessionEnableSignature))) {
        throw new Error("Persisted agent session authorization signature is malformed.")
    }
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
        || typeof ownerAddress !== "string" || !isAddress(ownerAddress)
        || typeof account !== "string" || !isAddress(account)
        || typeof targetToken !== "string" || !isAddress(targetToken)
        || typeof amountBnb !== "string"
        || typeof entryPriceMicros !== "string" || !/^[0-9]+$/.test(entryPriceMicros)
        || typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500
        || typeof maxPriceImpactBps !== "number" || !Number.isInteger(maxPriceImpactBps) || maxPriceImpactBps < 1 || maxPriceImpactBps > 300) {
        throw new Error("Persisted strategy is missing a required field or contains an invalid value.")
    }
    const normalizedOwner = getAddress(ownerAddress)
    if (normalizedOwner !== getAddress(expectedOwnerAddress)) throw new Error("Persisted strategy owner does not match the schedule owner.")
    const normalizedTarget = getAddress(targetToken)
    if (normalizedTarget !== config.targetTokenAddress) throw new Error("Persisted strategy token does not match the configured agent token.")
    const parsedAmount = parseEther(amountBnb)
    if (parsedAmount <= BigInt(0) || parsedAmount > MAX_TRADE_BNB) throw new Error("Persisted strategy amount exceeds the worker's hard trade limit.")
    const parsedEntry = BigInt(entryPriceMicros)
    if (parsedEntry <= BigInt(0)) throw new Error("Persisted strategy entry-price threshold must be positive.")
    return {
        strategy: {
            id,
            ownerAddress: normalizedOwner,
            account: getAddress(account),
            targetToken: normalizedTarget,
            amountBnb: parsedAmount,
            entryPriceMicros: parsedEntry,
            slippageBps,
            maxPriceImpactBps
        },
        ...(typeof sessionEnableSignature === "string" ? { sessionEnableSignature: sessionEnableSignature as Hex } : {})
    }
}

async function createPersistentWorkerRuntime() {
    const config = getAgentSmartAccountConfig()
    const agentAccount = loadPrivateKey()
    const publicClient = createAgentPublicClient(config)
    const validatorReader = createViemValidatorReader(publicClient, config.policyHookAddress)
    const store = new AgentMemoryStore()
    await store.initialize()
    const workerId = process.env.WOLV_AGENT_WORKER_ID?.trim() || `persistent-bsc-agent-worker-${config.chain.id}`
    const alertNotifier = createAlertNotifier({ webhookUrl: process.env.WOLV_ALERT_WEBHOOK_URL, workerId })
    const persistAlert = store.recordAlert.bind(store)
    store.recordAlert = async (input) => {
        const alertId = await persistAlert(input)
        void alertNotifier.notify(input)
        return alertId
    }
    const runtimes = new Map<string, PersistentScheduleRuntime>()

    function createScheduleRuntime(schedule: Record<string, unknown>, stored: StoredStrategy): PersistentScheduleRuntime {
        const { strategy, sessionEnableSignature } = stored
        const scheduleId = String(schedule.scheduleId)
        const policyHash = String(schedule.policyHash).toLowerCase()
        const configHash = createHash("sha256").update(JSON.stringify({
            strategyConfig: schedule.strategyConfig,
            policyVersion: schedule.policyVersion,
            policyHash,
        })).digest("hex")
        const cached = runtimes.get(scheduleId)
        if (cached && cached.configHash === configHash) return cached

        const context: PersistentScheduleContext = { activeClaim: null, lastTelemetry: null, panicStopped: false }
        const workerReference: { current: AgentWorker | undefined } = { current: undefined }
        const executor = new AgentExecutor({
            getConfig: () => config,
            // The owner validator is built from the owner's PUBLIC address and can never sign.
            // The only owner authorization the worker holds is the one-time enable signature
            // collected at policy setup; every trade is signed by the delegated agent key.
            resolveAuthorization: async intent => ({
                ownerValidator: await createOwnerValidatorFromAddress(publicClient, intent.ownerAddress),
                sessionKeySigner: agentAccount,
                pluginEnableSignature: sessionEnableSignature,
            }),
            maxIntentAgeMs: QUOTE_SUBMISSION_BUDGET_MS,
            log: event => {
                console.info(JSON.stringify(event))
                if (event.event === "userop_submitted" && context.activeClaim) {
                    const active = context.activeClaim
                    active.userOperationHash = event.userOperationHash
                    active.submissionUpdate = store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                        status: "SUBMITTED",
                        providerReference: event.userOperationHash,
                        at: Date.now(),
                    }).then(() => { active.status = "SUBMITTED" })
                }
            },
            onFailure: createWorkerFailureReporter({
                reportExecutionFailure: (strategyId, reasonCode, detail) => {
                    workerReference.current?.reportExecutionFailure(strategyId, reasonCode, detail)
                },
            }),
        })
        const worker = new AgentWorker({
            strategies: [strategy],
            readMarket: current => fetchMarketData(current, config, publicClient),
            readValidator: async current => {
                const snapshot = await validatorReader(current)
                const scheduleHashMatches = schedule.policyVersion === "WOLV_AGENT_POLICY_V4"
                    && snapshot.policyHash.slice(2).toLowerCase() === policyHash
                return scheduleHashMatches ? snapshot : { ...snapshot, policyHash: ("0x" + "1".repeat(64)) as Hex }
            },
            log: event => {
                context.lastTelemetry = event
                console.info(JSON.stringify(event))
                void store.recordScheduleEvaluation({
                    ownerAddress: String(schedule.ownerAddress),
                    scheduleId,
                    at: Date.now(),
                    evaluation: {
                        reasonCode: event.reasonCode,
                        timestamp: event.timestamp,
                        targetToken: event.targetToken,
                        currentPriceMicros: event.currentPriceMicros ?? null,
                        entryPriceMicros: strategy.entryPriceMicros.toString(),
                        attemptedTradeBnb: event.attemptedTradeBnb,
                        priceImpactBps: event.priceImpactBps ?? null,
                        slippageBps: event.slippageBps,
                    },
                }).catch(error => {
                    console.error("Could not persist agent evaluation:", error instanceof Error ? error.message : String(error))
                })
            },
            alert: async event => {
                console.error(JSON.stringify(event))
                context.panicStopped = true
                const active = context.activeClaim
                if (!active) return
                await store.setScheduleEnabled(active.ownerAddress, active.scheduleId, false, Date.now()).catch(error => {
                    console.error("Could not disable panic-stopped autonomous schedule:", error instanceof Error ? error.message : String(error))
                })
                await store.recordAlert({
                    ownerAddress: active.ownerAddress,
                    claimId: active.claimId,
                    severity: "CRITICAL",
                    kind: event.reasonCode,
                    message: event.message,
                    createdAt: Date.now(),
                }).catch(error => {
                    console.error("Could not persist autonomous worker panic alert:", error instanceof Error ? error.message : String(error))
                })
            },
            onIntent: async intent => {
                const active = context.activeClaim
                if (!active) throw new Error("Autonomous schedule execution has no durable claim.")
                const quoteReceivedAt = Date.parse(intent.createdAt)
                if (!Number.isFinite(quoteReceivedAt) || Date.now() - quoteReceivedAt > QUOTE_SUBMISSION_BUDGET_MS) {
                    await store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                        status: "STOPPED", failureCode: "QUOTE_STALE",
                        failureDetail: "Market quote exceeded the submission freshness budget.", at: Date.now(),
                    })
                    active.status = "STOPPED"
                    workerReference.current?.acknowledgeIntent(intent.strategyId)
                    return
                }
                try {
                    const result = await executor.executeUserOperation(intent)
                    await active.submissionUpdate
                    if (active.status !== "SUBMITTED") {
                        await store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                            status: "SUBMITTED", providerReference: result.userOperationHash, at: Date.now(),
                        })
                        active.status = "SUBMITTED"
                    }
                    await store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                        status: "CONFIRMED", receiptHash: result.transactionHash,
                        providerReference: result.userOperationHash,
                        evidence: result.evidence, at: Date.now(),
                    })
                    active.status = "CONFIRMED"
                    console.info(JSON.stringify({ event: "agent_trade_verified", claimId: active.claimId, ...result.evidence }))
                } catch (error) {
                    await active.submissionUpdate?.catch(() => undefined)
                    const code = isRecord(error) && typeof error.code === "string" ? error.code : "AGENT_EXECUTION_FAILED"
                    const detail = error instanceof Error ? error.message : "Unknown autonomous execution error."
                    const submissionUncertain = Boolean(active.userOperationHash)
                    const fatalPolicyFailure = ["POLICY_HASH_MISMATCH", "POLICY_EXPIRED", "POLICY_REVOKED", "POLICY_NOT_CONFIGURED", "SESSION_REVOKED", "SESSION_NOT_INSTALLED"].includes(code)
                    const disableSchedule = submissionUncertain || fatalPolicyFailure
                    const status = submissionUncertain ? "STOPPED" : "FAILED"
                    await store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                        status, failureCode: code, failureDetail: detail,
                        ...(active.userOperationHash ? { providerReference: active.userOperationHash } : {}),
                        at: Date.now(),
                    })
                    active.status = status
                    if (disableSchedule) {
                        await store.setScheduleEnabled(active.ownerAddress, active.scheduleId, false, Date.now()).catch(disableError => {
                            console.error("Could not disable schedule after uncertain UserOperation submission:", disableError instanceof Error ? disableError.message : String(disableError))
                        })
                    }
                    await store.recordAlert({
                        ownerAddress: active.ownerAddress, claimId: active.claimId,
                        severity: disableSchedule ? "CRITICAL" : "WARNING",
                        kind: submissionUncertain ? "USEROP_RECEIPT_UNCERTAIN" : code,
                        message: detail, createdAt: Date.now(),
                    }).catch(alertError => {
                        console.error("Could not persist autonomous execution failure alert:", alertError instanceof Error ? alertError.message : String(alertError))
                    })
                    throw error
                } finally {
                    workerReference.current?.acknowledgeIntent(intent.strategyId)
                }
            },
        }, { intervalMs: POLL_INTERVAL_MS, maxConsecutiveFailures: 3, maxMarketAgeMs: 20_000 })
        workerReference.current = worker
        const runtime = { configHash, worker, context }
        runtimes.set(scheduleId, runtime)
        return runtime
    }

    async function processSchedule(schedule: Record<string, unknown>) {
        const scheduleId = String(schedule.scheduleId ?? "")
        const ownerAddress = String(schedule.ownerAddress ?? "")
        const policyHash = String(schedule.policyHash ?? "").toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(policyHash) || schedule.policyVersion !== "WOLV_AGENT_POLICY_V4") {
            await store.setScheduleEnabled(ownerAddress, scheduleId, false, Date.now()).catch(() => undefined)
            await store.recordAlert({ ownerAddress, severity: "WARNING", kind: "POLICY_VERSION_MISMATCH",
                message: "Autonomous schedule was disabled because its policy hash or version is invalid.", createdAt: Date.now() })
            return
        }
        let strategy: StoredStrategy
        try {
            strategy = parseStoredStrategy(schedule.strategyConfig, config, ownerAddress)
        } catch (error) {
            await store.setScheduleEnabled(ownerAddress, scheduleId, false, Date.now()).catch(() => undefined)
            await store.recordAlert({ ownerAddress, severity: "WARNING", kind: "INVALID_STRATEGY_CONFIG",
                message: error instanceof Error ? error.message : "Persisted strategy configuration is invalid.", createdAt: Date.now() })
            return
        }
        const lastRunAt = Number(schedule.lastRunAt)
        if (!Number.isSafeInteger(lastRunAt) || lastRunAt <= 0) return
        const runKey = createHash("sha256").update(scheduleId + ":" + String(lastRunAt)).digest("hex")
        const claimId = randomUUID()
        const claim = await store.claimExecution({
            claimId, scheduleId, ownerAddress, runKey, policyHash, createdAt: Date.now(),
        })
        if (!claim.claimId) return
        let runtime: PersistentScheduleRuntime
        try {
            runtime = createScheduleRuntime(schedule, strategy)
        } catch (error) {
            const detail = error instanceof Error ? error.message : "Autonomous schedule runtime could not be created."
            await store.updateExecutionClaim(claimId, ownerAddress, {
                status: "FAILED", failureCode: "WORKER_RUNTIME_INIT_FAILED", failureDetail: detail, at: Date.now(),
            })
            await store.recordAlert({ ownerAddress, claimId, severity: "CRITICAL", kind: "WORKER_RUNTIME_INIT_FAILED", message: detail, createdAt: Date.now() })
            return
        }
        const active: ActiveScheduleClaim = { claimId, scheduleId, ownerAddress, status: "CLAIMED" }
        runtime.context.activeClaim = active
        runtime.context.lastTelemetry = null
        runtime.context.panicStopped = false
        try {
            await runtime.worker.evaluateOnce()
            if (active.status === "CLAIMED") {
                const lastTelemetry = getLastTelemetry(runtime.context)
                const reason = runtime.context.panicStopped ? "WORKER_PANIC_STOP" : lastTelemetry?.reasonCode ?? "NO_EXECUTION"
                const detail = lastTelemetry?.detail ?? "No trade intent was submitted during this schedule evaluation."
                await store.updateExecutionClaim(claimId, ownerAddress, {
                    status: "STOPPED", failureCode: reason, failureDetail: detail, at: Date.now(),
                })
                active.status = "STOPPED"
                if (reason !== "TRIGGER_NOT_MET" && reason !== "SLIPPAGE_HIGH") {
                    const disableSchedule = ["WORKER_PANIC_STOP", "POLICY_HASH_MISMATCH", "POLICY_EXPIRED", "SESSION_REVOKED",
                        "SESSION_NOT_INSTALLED", "POLICY_NOT_CONFIGURED", "TRADE_CAP_EXCEEDED"].includes(reason)
                    if (disableSchedule && !runtime.context.panicStopped) await store.setScheduleEnabled(ownerAddress, scheduleId, false, Date.now())
                    if (!runtime.context.panicStopped) await store.recordAlert({
                        ownerAddress, claimId, severity: disableSchedule ? "CRITICAL" : "WARNING",
                        kind: reason, message: detail, createdAt: Date.now(),
                    })
                }
            }
        } catch (error) {
            if (active.status === "CLAIMED") {
                await store.updateExecutionClaim(claimId, ownerAddress, {
                    status: "FAILED", failureCode: "WORKER_CYCLE_FAILED",
                    failureDetail: error instanceof Error ? error.message : "Unknown worker cycle failure.", at: Date.now(),
                })
            }
            await store.recordAlert({
                ownerAddress, claimId, severity: "CRITICAL", kind: "WORKER_CYCLE_FAILED",
                message: error instanceof Error ? error.message : "Unknown worker cycle failure.", createdAt: Date.now(),
            })
        } finally {
            await store.rescheduleAutonomousAgentSchedule(ownerAddress, scheduleId, Date.now()).catch(error => {
                console.error("Could not reschedule autonomous strategy after worker cycle:", error instanceof Error ? error.message : String(error))
            })
            runtime.context.activeClaim = null
        }
    }

    async function heartbeat() {
        const now = Date.now()
        const network = resolveAgentExecutionNetwork(config.chain.id)
        const control = await store.getControlState(now)
        const explicitlyStopped = control.emergency_stop === true || control.stop_monitoring === true || control.reject_new_opportunities === true
        // An owner release of the global stop is a time-boxed lease: once it lapses the worker
        // fails closed until the owner releases it again.
        const leaseExpired = !explicitlyStopped && control.permission_active !== true
        const globallyPaused = explicitlyStopped || leaseExpired
        const pauseReason = leaseExpired
            ? "The owner's global control release has expired. Release the global stop again from /agent."
            : String(control.stop_reason ?? "Global agent control is paused.")
        await store.recordWorkerHeartbeat({
            workerId,
            workerMode: "PERSISTENT_AUTONOMOUS",
            chainId: config.chain.id,
            lastSeenAt: now,
            metadata: {
                executionGateEnabled: network.allowed,
                executionGateReason: network.allowed ? null : network.reason,
                globallyPaused,
                pauseReason: globallyPaused ? pauseReason : null,
                processId: process.pid,
            },
        })
        return { network, globallyPaused, pauseReason }
    }

    async function poll() {
        const now = Date.now()
        const state = await heartbeat()
        if (!state.network.allowed) {
            console.warn(JSON.stringify({ event: "autonomous_worker_gated", reason: state.network.reason, chainId: config.chain.id }))
            return
        }
        if (state.globallyPaused) {
            console.warn(JSON.stringify({ event: "autonomous_worker_paused", reason: state.pauseReason }))
            return
        }
        for (const expired of await store.expireStaleExecutionClaims(now, EXECUTION_LEASE_MS)) {
            console.warn(JSON.stringify({ event: "execution_lease_expired", ...expired }))
            await store.recordAlert({
                ownerAddress: expired.ownerAddress, claimId: expired.claimId, severity: "WARNING",
                kind: "LEASE_EXPIRED", message: "A worker lease expired before submission; the schedule run was released.",
                createdAt: now,
            }).catch(() => undefined)
        }
        const schedules = await store.claimDueAutonomousAgentSchedules(now, 20)
        for (const schedule of schedules) await processSchedule(schedule)
    }

    return {
        poll,
        heartbeat,
        close: async () => {
            for (const runtime of runtimes.values()) runtime.worker.stop()
            await store.close()
        },
    }
}

async function mainPersistent() {
    const runtime = await createPersistentWorkerRuntime()
    let shuttingDown = false
    let activePoll: Promise<void> | undefined
    let activeHeartbeat: Promise<void> | undefined
    const pulseHeartbeat = async () => {
        if (shuttingDown || activeHeartbeat) return
        activeHeartbeat = runtime.heartbeat().then(() => undefined).catch(error => {
            console.error("Autonomous worker heartbeat failed:", error instanceof Error ? error.message : String(error))
        }).finally(() => { activeHeartbeat = undefined })
        await activeHeartbeat
    }
    const pollSchedules = async () => {
        if (shuttingDown || activePoll) return
        activePoll = runtime.poll().catch(error => {
            console.error("Autonomous schedule poll failed:", error instanceof Error ? error.message : String(error))
        }).finally(() => { activePoll = undefined })
        await activePoll
    }
    const marketPulseRefresher = startMarketPulseRefresher({
        url: process.env.MARKET_PULSE_REFRESH_URL,
        cronSecret: process.env.CRON_SECRET,
    })
    const timer = setInterval(() => { void pollSchedules() }, POLL_INTERVAL_MS)
    const heartbeatTimer = setInterval(() => { void pulseHeartbeat() }, POLL_INTERVAL_MS)
    void pulseHeartbeat()
    void pollSchedules()
    const gracefulShutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return
        shuttingDown = true
        console.info("Received " + signal + "; stopping persistent autonomous worker.")
        clearInterval(timer)
        clearInterval(heartbeatTimer)
        marketPulseRefresher?.stop()
        await activePoll
        await activeHeartbeat
        await runtime.close()
        await closeIntentNonceTracker()
        console.info("Persistent autonomous worker stopped.")
    }
    process.once("SIGINT", () => { void gracefulShutdown("SIGINT").catch(error => { console.error("Worker shutdown failed:", error); process.exitCode = 1 }) })
    process.once("SIGTERM", () => { void gracefulShutdown("SIGTERM").catch(error => { console.error("Worker shutdown failed:", error); process.exitCode = 1 }) })
}

async function main() {
    // Persistent, database-backed operation is the only supported mode: durable claims are
    // what prevent duplicate trades across restarts and concurrent workers.
    if (!process.env.WOLV_AGENT_DATABASE_URL && !process.env.WOLV_TRADING_DATABASE_URL) {
        throw new Error("WOLV_AGENT_DATABASE_URL is required; the autonomous worker never runs without durable execution claims.")
    }
    await mainPersistent()
}

export async function startWithRetry(
    start: () => Promise<void>,
    options: { baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void>; maxAttempts?: number } = {},
): Promise<void> {
    const baseDelayMs = options.baseDelayMs ?? 5_000
    const maxDelayMs = options.maxDelayMs ?? 5 * 60_000
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
    for (let attempt = 1; ; attempt++) {
        try {
            await start()
            return
        } catch (error) {
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 16))
            console.error(`Agent worker failed to start (attempt ${attempt}); retrying in ${Math.round(delay / 1000)}s:`,
                error instanceof Error ? error.message : String(error))
            if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) throw error
            await sleep(delay)
        }
    }
}

const isDirectExecution = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectExecution) {
    try {
        loadWorkerEnvironment()
        // Self-healing without relying on the host's restart policy: a failed start (database,
        // RPC, or configuration temporarily unavailable) is retried with capped backoff, and a
        // stray rejected promise is logged instead of terminating the process. Durable execution
        // claims make a restarted cycle safe; the global stop and on-chain policy still apply.
        process.on("unhandledRejection", reason => {
            console.error("Unhandled rejection in agent worker (continuing):", reason instanceof Error ? reason.message : String(reason))
        })
        void startWithRetry(main)
    } catch (error) {
        console.error("Agent worker failed to load environment:", error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    }
}
