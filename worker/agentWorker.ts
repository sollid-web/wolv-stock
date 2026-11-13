import { pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { KernelValidator } from "@zerodev/sdk"
import type { AgentSmartAccountConfig } from "../lib/smartAccount.ts"
import {
    createAgentPublicClient,
    getAgentSmartAccountConfig,
    type PoolReserves
} from "../lib/smartAccount.ts"
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
    type AgentCycleTelemetry,
    type MarketSnapshot
} from "../services/agentWorker.ts"
import { closeIntentNonceTracker } from "../services/agentIntentNonceTracker.ts"
import { AgentMemoryStore } from "../services/agentMemoryStore.ts"
import { loadWorkerEnvironment } from "./workerEnvironment.ts"
import {
    getAddress,
    isAddress,
    parseEther,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { PublicClient } from "viem"

const POLL_INTERVAL_MS = 5_000
const QUOTE_SUBMISSION_BUDGET_MS = 15_000
const MOCK_RESERVES: PoolReserves = {
    reserveIn: parseEther("1000"),
    reserveOut: parseEther("1000000")
}

type MockMarketQuote = {
    tokenIn: Address
    tokenOut: Address
    amountIn: bigint
    amountOutMin: bigint
    timestamp: number
}

type MarketDataProvider = {
    fetchMarketData: (
        strategy: AgentStrategy,
        context: { config: AgentSmartAccountConfig; client: PublicClient }
    ) => Promise<MarketSnapshot>
}

type OwnerValidatorProvider = {
    getOwnerValidator: (
        account: Address,
        config: AgentSmartAccountConfig
    ) => Promise<KernelValidator>
}

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

function readStrategies(config: AgentSmartAccountConfig): AgentStrategy[] {
    const raw = process.env.AGENT_STRATEGIES_JSON
    if (!raw) throw new Error("AGENT_STRATEGIES_JSON must contain the configured account strategies.")

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error("AGENT_STRATEGIES_JSON must be valid JSON.")
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("AGENT_STRATEGIES_JSON must be a non-empty array.")
    }

    return parsed.map((value, index): AgentStrategy => {
        if (!isRecord(value)) throw new Error(`Strategy ${index} must be an object.`)
        const { id, ownerAddress, account, targetToken, amountBnb, entryPriceMicros, slippageBps, maxPriceImpactBps } = value
        if (
            typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
            || typeof ownerAddress !== "string" || !isAddress(ownerAddress)
            || typeof account !== "string" || !isAddress(account)
            || typeof targetToken !== "string" || !isAddress(targetToken)
            || typeof amountBnb !== "string"
            || typeof entryPriceMicros !== "string" || !/^[0-9]+$/.test(entryPriceMicros)
            || typeof slippageBps !== "number" || !Number.isInteger(slippageBps)
            || slippageBps < 1 || slippageBps > 500
            || typeof maxPriceImpactBps !== "number" || !Number.isInteger(maxPriceImpactBps)
            || maxPriceImpactBps < 1 || maxPriceImpactBps > 300
        ) {
            throw new Error(`Strategy ${index} has invalid or missing fields.`)
        }
        if (BigInt(entryPriceMicros) <= BigInt(0)) {
            throw new Error(`Strategy ${id} entryPriceMicros must be greater than zero.`)
        }
        const parsedAmount = parseEther(amountBnb)
        if (parsedAmount <= BigInt(0) || parsedAmount > MAX_TRADE_BNB) {
            throw new Error(`Strategy ${id} trade amount must be greater than zero and at most 0.5 BNB.`)
        }
        const normalizedTarget = getAddress(targetToken)
        if (normalizedTarget !== config.targetTokenAddress) {
            throw new Error(`Strategy ${id} target token must match NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS.`)
        }
        return {
            id,
            ownerAddress: getAddress(ownerAddress),
            account: getAddress(account),
            targetToken: normalizedTarget,
            amountBnb: parsedAmount,
            entryPriceMicros: BigInt(entryPriceMicros),
            slippageBps,
            maxPriceImpactBps
        }
    })
}

async function loadProvider<T>(
    modulePath: string | undefined,
    exportName: keyof T,
    errorMessage: string
): Promise<T[keyof T]> {
    if (!modulePath) throw new Error(errorMessage)
    const imported: unknown = await import(pathToFileURL(resolve(modulePath)).href)
    if (!isRecord(imported)) throw new Error(`Module ${modulePath} has no named exports.`)
    const provider = imported[exportName as string]
    if (typeof provider !== "function") {
        throw new Error(`Module ${modulePath} must export ${String(exportName)} as a function.`)
    }
    return provider as T[keyof T]
}

export async function fetchMarketData(
    strategy: AgentStrategy,
    config: AgentSmartAccountConfig,
    client: PublicClient,
    marketProvider?: MarketDataProvider["fetchMarketData"]
): Promise<MarketSnapshot & { quote?: MockMarketQuote }> {
    if (marketProvider) {
        const snapshot = await marketProvider(strategy, { config, client })
        return { ...snapshot, receivedAt: Date.now() }
    }

    const receivedAt = Date.now()
    const quote: MockMarketQuote = {
        tokenIn: config.wrappedNativeAddress,
        tokenOut: strategy.targetToken,
        amountIn: strategy.amountBnb,
        amountOutMin: BigInt(1),
        timestamp: receivedAt
    }
    console.info(JSON.stringify({
        event: "mock_market_quote",
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn.toString(),
        amountOutMin: quote.amountOutMin.toString(),
        timestamp: quote.timestamp
    }))

    return {
        priceMicros: strategy.entryPriceMicros + BigInt(1),
        reserves: MOCK_RESERVES,
        observedAt: receivedAt,
        receivedAt,
        quote
    }
}

async function createWorkerRuntime() {
    const config = getAgentSmartAccountConfig()
    const agentAccount = loadPrivateKey()
    const strategies = readStrategies(config)
    const publicClient = createAgentPublicClient(config)
    const validatorReader = createViemValidatorReader(publicClient, config.policyHookAddress)
    const marketProvider = process.env.AGENT_MARKET_DATA_MODULE
        ? await loadProvider<MarketDataProvider>(
            process.env.AGENT_MARKET_DATA_MODULE,
            "fetchMarketData",
            "AGENT_MARKET_DATA_MODULE is required for live market data."
        )
        : undefined
    const getOwnerValidator = marketProvider
        ? await loadProvider<OwnerValidatorProvider>(
            process.env.AGENT_OWNER_VALIDATOR_MODULE,
            "getOwnerValidator",
            "AGENT_OWNER_VALIDATOR_MODULE must provide the account's owner validator."
        )
        : async () => {
            throw new Error("Owner validator provider is required before live UserOperation submission.")
        }

    const workerReference: { current: AgentWorker | undefined } = { current: undefined }
    const reportExecutionFailure = createWorkerFailureReporter({
        reportExecutionFailure: (strategyId, reasonCode, detail) => {
            workerReference.current?.reportExecutionFailure(strategyId, reasonCode, detail)
        }
    })
    const executor = new AgentExecutor({
        getConfig: () => config,
        resolveAuthorization: async intent => ({
            ownerValidator: await getOwnerValidator(intent.account, config),
            sessionKeySigner: agentAccount
        }),
        maxIntentAgeMs: QUOTE_SUBMISSION_BUDGET_MS,
        log: event => {
            const write = event.event === "userop_failed" ? console.error : console.info
            write(JSON.stringify(event))
        },
        onFailure: reportExecutionFailure
    })

    const worker = new AgentWorker({
        strategies,
        readMarket: strategy => fetchMarketData(
            strategy,
            config,
            publicClient,
            marketProvider
        ),
        readValidator: validatorReader,
        log: event => console.info(JSON.stringify(event)),
        alert: event => console.error(JSON.stringify(event)),
        onIntent: async intent => {
            const quoteReceivedAt = Date.parse(intent.createdAt)
            if (
                !Number.isFinite(quoteReceivedAt)
                || Date.now() - quoteReceivedAt > QUOTE_SUBMISSION_BUDGET_MS
            ) {
                console.warn("Quote stale, aborting")
                worker.acknowledgeIntent(intent.strategyId)
                return
            }
            if (!marketProvider) {
                console.warn("Mock quote produced a signal; UserOperation submission is disabled for mock data.")
                worker.acknowledgeIntent(intent.strategyId)
                return
            }
            try {
                const result = await executor.executeUserOperation(intent)
                console.info(JSON.stringify({
                    event: "agent_trade_submitted",
                    userOpHash: result.userOperationHash,
                    transactionHash: result.transactionHash
                }))
            } catch (error) {
                console.error(JSON.stringify({
                    event: "agent_trade_submission_failed",
                    error: error instanceof Error ? error.message : "Unknown executor error"
                }))
            } finally {
                worker.acknowledgeIntent(intent.strategyId)
            }
        }
    }, {
        intervalMs: POLL_INTERVAL_MS,
        maxConsecutiveFailures: 3,
        maxMarketAgeMs: 20_000
    })
    workerReference.current = worker

    return worker
}

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

function parseStoredStrategy(value: unknown, config: AgentSmartAccountConfig, expectedOwnerAddress: string): AgentStrategy {
    if (!isRecord(value)) throw new Error("Persisted strategy configuration must be an object.")
    const { id, ownerAddress, account, targetToken, amountBnb, entryPriceMicros, slippageBps, maxPriceImpactBps } = value
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
        id,
        ownerAddress: normalizedOwner,
        account: getAddress(account),
        targetToken: normalizedTarget,
        amountBnb: parsedAmount,
        entryPriceMicros: parsedEntry,
        slippageBps,
        maxPriceImpactBps
    }
}

async function createPersistentWorkerRuntime() {
    const config = getAgentSmartAccountConfig()
    const agentAccount = loadPrivateKey()
    const publicClient = createAgentPublicClient(config)
    const validatorReader = createViemValidatorReader(publicClient, config.policyHookAddress)
    const marketProvider = await loadProvider<MarketDataProvider>(
        process.env.AGENT_MARKET_DATA_MODULE,
        "fetchMarketData",
        "AGENT_MARKET_DATA_MODULE is required for persistent autonomous trading schedules.",
    )
    const getOwnerValidator = await loadProvider<OwnerValidatorProvider>(
        process.env.AGENT_OWNER_VALIDATOR_MODULE,
        "getOwnerValidator",
        "AGENT_OWNER_VALIDATOR_MODULE must provide the account's owner validator.",
    )
    const store = new AgentMemoryStore()
    await store.initialize()
    const workerId = process.env.WOLV_AGENT_WORKER_ID?.trim() || "persistent-bsc-agent-worker"
    const runtimes = new Map<string, PersistentScheduleRuntime>()

    function createScheduleRuntime(schedule: Record<string, unknown>, strategy: AgentStrategy): PersistentScheduleRuntime {
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
            resolveAuthorization: async intent => ({
                ownerValidator: await getOwnerValidator(intent.account, config),
                sessionKeySigner: agentAccount,
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
            readMarket: current => fetchMarketData(current, config, publicClient, marketProvider),
            readValidator: async current => {
                const snapshot = await validatorReader(current)
                const scheduleHashMatches = schedule.policyVersion === "WOLV_AGENT_POLICY_V4"
                    && snapshot.policyHash.slice(2).toLowerCase() === policyHash
                return scheduleHashMatches ? snapshot : { ...snapshot, policyHash: ("0x" + "1".repeat(64)) as Hex }
            },
            log: event => {
                context.lastTelemetry = event
                console.info(JSON.stringify(event))
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
                        providerReference: result.userOperationHash, at: Date.now(),
                    })
                    active.status = "CONFIRMED"
                } catch (error) {
                    await active.submissionUpdate?.catch(() => undefined)
                    const code = isRecord(error) && typeof error.code === "string" ? error.code : "AGENT_EXECUTION_FAILED"
                    const detail = error instanceof Error ? error.message : "Unknown autonomous execution error."
                    const status = active.userOperationHash ? "STOPPED" : "FAILED"
                    await store.updateExecutionClaim(active.claimId, active.ownerAddress, {
                        status, failureCode: code, failureDetail: detail,
                        ...(active.userOperationHash ? { providerReference: active.userOperationHash } : {}),
                        at: Date.now(),
                    })
                    active.status = status
                    await store.recordAlert({
                        ownerAddress: active.ownerAddress, claimId: active.claimId,
                        severity: status === "FAILED" ? "CRITICAL" : "WARNING",
                        kind: code, message: detail, createdAt: Date.now(),
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
        let strategy: AgentStrategy
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
                const reason = runtime.context.panicStopped ? "WORKER_PANIC_STOP" : runtime.context.lastTelemetry?.reasonCode ?? "NO_EXECUTION"
                const detail = runtime.context.lastTelemetry?.detail ?? "No trade intent was submitted during this schedule evaluation."
                await store.updateExecutionClaim(claimId, ownerAddress, {
                    status: "STOPPED", failureCode: reason, failureDetail: detail, at: Date.now(),
                })
                active.status = "STOPPED"
                if (reason !== "TRIGGER_NOT_MET" && reason !== "SLIPPAGE_HIGH") {
                    const disableSchedule = ["WORKER_PANIC_STOP", "POLICY_HASH_MISMATCH", "POLICY_EXPIRED", "SESSION_REVOKED",
                        "SESSION_NOT_INSTALLED", "POLICY_NOT_CONFIGURED", "CIRCUIT_BREAKER_PAUSED", "TRADE_CAP_EXCEEDED"].includes(reason)
                    if (disableSchedule) await store.setScheduleEnabled(ownerAddress, scheduleId, false, Date.now())
                    await store.recordAlert({
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
            runtime.context.activeClaim = null
        }
    }

    async function poll() {
        const now = Date.now()
        const network = resolveAgentExecutionNetwork(config.chain.id)
        const control = await store.getControlState()
        const globallyPaused = control.emergency_stop === true || control.stop_monitoring === true || control.reject_new_opportunities === true
        await store.recordWorkerHeartbeat({
            workerId,
            workerMode: "PERSISTENT_AUTONOMOUS",
            chainId: config.chain.id,
            lastSeenAt: now,
            metadata: {
                executionGateEnabled: network.allowed,
                executionGateReason: network.allowed ? null : network.reason,
                globallyPaused,
                pauseReason: globallyPaused ? control.stop_reason ?? "Global agent control is paused." : null,
            },
        })
        if (!network.allowed) {
            console.warn(JSON.stringify({ event: "autonomous_worker_gated", reason: network.reason, chainId: config.chain.id }))
            return
        }
        if (globallyPaused) {
            console.warn(JSON.stringify({ event: "autonomous_worker_paused", reason: control.stop_reason ?? "Global agent control is paused." }))
            return
        }
        const schedules = await store.claimDueAutonomousAgentSchedules(now, 20)
        for (const schedule of schedules) await processSchedule(schedule)
    }

    return {
        poll,
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
    const pollSchedules = async () => {
        if (shuttingDown || activePoll) return
        activePoll = runtime.poll().catch(error => {
            console.error("Autonomous schedule poll failed:", error instanceof Error ? error.message : String(error))
        }).finally(() => { activePoll = undefined })
        await activePoll
    }
    const timer = setInterval(() => { void pollSchedules() }, POLL_INTERVAL_MS)
    void pollSchedules()
    const gracefulShutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return
        shuttingDown = true
        console.info("Received " + signal + "; stopping persistent autonomous worker.")
        clearInterval(timer)
        await activePoll
        await runtime.close()
        await closeIntentNonceTracker()
        console.info("Persistent autonomous worker stopped.")
    }
    process.once("SIGINT", () => { void gracefulShutdown("SIGINT").catch(error => { console.error("Worker shutdown failed:", error); process.exitCode = 1 }) })
    process.once("SIGTERM", () => { void gracefulShutdown("SIGTERM").catch(error => { console.error("Worker shutdown failed:", error); process.exitCode = 1 }) })
}

async function main() {
    if (process.env.WOLV_AGENT_DATABASE_URL || process.env.WOLV_TRADING_DATABASE_URL) {
        await mainPersistent()
        return
    }
    await mainStatic()
}
async function mainStatic() {
    const worker = await createWorkerRuntime()
    let shuttingDown = false
    let activePoll: Promise<void> | undefined
    const pollMarkets = async () => {
        if (shuttingDown || activePoll) return
        activePoll = worker.evaluateOnce()
            .catch(error => {
                console.error("Agent market poll failed:", error instanceof Error ? error.message : String(error))
            })
            .finally(() => {
                activePoll = undefined
            })
        await activePoll
    }

    const timer = setInterval(() => {
        void pollMarkets()
    }, POLL_INTERVAL_MS)
    void pollMarkets()

    const gracefulShutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return
        shuttingDown = true
        console.info(`Received ${signal}; stopping agent worker.`)
        clearInterval(timer)
        worker.stop()
        await activePoll
        await closeIntentNonceTracker()
        console.info("Agent worker stopped.")
    }
    process.once("SIGINT", () => {
        void gracefulShutdown("SIGINT").catch(error => {
            console.error("Agent worker shutdown failed:", error)
            process.exitCode = 1
        })
    })
    process.once("SIGTERM", () => {
        void gracefulShutdown("SIGTERM").catch(error => {
            console.error("Agent worker shutdown failed:", error)
            process.exitCode = 1
        })
    })
}

const isDirectExecution = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectExecution) {
    try {
        loadWorkerEnvironment()
        void main().catch(error => {
            console.error("Agent worker failed to start:", error instanceof Error ? error.message : String(error))
            process.exitCode = 1
        })
    } catch (error) {
        console.error("Agent worker failed to load environment:", error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    }
}
