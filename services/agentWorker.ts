import type { Address, Client, Hex } from "viem"
import { readContract } from "viem/actions"
import {
    calculateDynamicQuote,
    type PoolReserves
} from "../lib/smartAccount.ts"

export const MAX_TRADE_BNB = BigInt("500000000000000000")
export const MAX_ROLLING_VOLUME_BNB = BigInt("1000000000000000000")

export type AgentStrategy = {
    id: string
    account: Address
    targetToken: Address
    amountBnb: bigint
    entryPriceMicros: bigint
    slippageBps: number
    maxPriceImpactBps: number
}

export type MarketSnapshot = {
    priceMicros: bigint
    reserves: PoolReserves
    observedAt: number
    receivedAt?: number
}

export type ValidatorSnapshot = {
    paused: boolean
    installed: boolean
    revoked: boolean
    rollingVolume: bigint
    policyConfigured: boolean
    policyHash: Hex
    maxTradeValue: bigint
    policyExpiresAt: bigint
    intentSigner: Address
}

export type AgentCycleReason =
    | "TRIGGER_NOT_MET"
    | "INTENT_PENDING"
    | "CAP_EXCEEDED"
    | "TRADE_CAP_EXCEEDED"
    | "CIRCUIT_BREAKER_PAUSED"
    | "SESSION_REVOKED"
    | "SESSION_NOT_INSTALLED"
    | "POLICY_NOT_CONFIGURED"
    | "POLICY_EXPIRED"
    | "SLIPPAGE_HIGH"
    | "VALIDATOR_PASS"
    | "RPC_FAILURE"
    | "WORKER_PANIC_STOP"
    | "BUNDLER_MEMPOOL_REJECTED"
    | "ONCHAIN_EXECUTION_REVERTED"
    | "USEROP_RECEIPT_TIMEOUT"

export type AgentCycleTelemetry = {
    type: "agent_evaluation"
    strategyId: string
    account: Address
    targetToken: Address
    timestamp: string
    currentPriceMicros?: string
    cumulativeVolumeBnb?: string
    attemptedTradeBnb: string
    remainingCapacityBnb?: string
    priceImpactBps?: number
    slippageBps: number
    reasonCode: AgentCycleReason
    detail?: string
}

export type AgentExecutionIntent = {
    strategyId: string
    account: Address
    targetToken: Address
    amountBnb: bigint
    amountOutMin: bigint
    priceImpactBps: number
    slippageBps: number
    maxPriceImpactBps: number
    sourcePriceMicros: bigint
    createdAt: string
    policyHash: Hex
}

export type AgentWorkerDependencies = {
    strategies: readonly AgentStrategy[]
    readMarket: (strategy: AgentStrategy) => Promise<MarketSnapshot>
    readValidator: (strategy: AgentStrategy) => Promise<ValidatorSnapshot>
    log: (event: AgentCycleTelemetry) => void
    alert: (event: {
        priority: "high"
        reasonCode: "WORKER_PANIC_STOP"
        message: string
        timestamp: string
    }) => void | Promise<void>
    onIntent?: (intent: AgentExecutionIntent) => void | Promise<void>
    now?: () => number
}

export type AgentWorkerOptions = {
    intervalMs: number
    maxConsecutiveFailures: number
    maxMarketAgeMs: number
}

const MAX_MARKET_AGE_MS = 20_000
const DEFAULT_OPTIONS: AgentWorkerOptions = {
    intervalMs: 5_000,
    maxConsecutiveFailures: 3,
    maxMarketAgeMs: MAX_MARKET_AGE_MS
}

const validatorAbi = [
    {
        type: "function",
        name: "paused",
        inputs: [],
        outputs: [{ type: "bool" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "isInitialized",
        inputs: [{ name: "smartAccount", type: "address" }],
        outputs: [{ type: "bool" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "isRevoked",
        inputs: [{ name: "smartAccount", type: "address" }],
        outputs: [{ type: "bool" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "getEffectiveRollingVolume",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "getAccountPolicy",
        inputs: [{ name: "account", type: "address" }],
        outputs: [
            { name: "configured", type: "bool" },
            { name: "policyHash", type: "bytes32" },
            { name: "maxTradeValue", type: "uint192" },
            { name: "expiresAt", type: "uint64" },
            { name: "intentSigner", type: "address" }
        ],
        stateMutability: "view"
    }
] as const

export function createViemValidatorReader(
    client: Client,
    validatorAddress: Address
) {
    return async (strategy: AgentStrategy): Promise<ValidatorSnapshot> => {
        const [paused, installed, revoked, rollingVolume, accountPolicy] = await Promise.all([
            readContract(client, {
                address: validatorAddress,
                abi: validatorAbi,
                functionName: "paused"
            }),
            readContract(client, {
                address: validatorAddress,
                abi: validatorAbi,
                functionName: "isInitialized",
                args: [strategy.account]
            }),
            readContract(client, {
                address: validatorAddress,
                abi: validatorAbi,
                functionName: "isRevoked",
                args: [strategy.account]
            }),
            readContract(client, {
                address: validatorAddress,
                abi: validatorAbi,
                functionName: "getEffectiveRollingVolume",
                args: [strategy.account]
            }),
            readContract(client, {
                address: validatorAddress,
                abi: validatorAbi,
                functionName: "getAccountPolicy",
                args: [strategy.account]
            })
        ])
        const [policyConfigured, policyHash, maxTradeValue, policyExpiresAt, intentSigner] =
            accountPolicy
        return {
            paused,
            installed,
            revoked,
            rollingVolume,
            policyConfigured,
            policyHash,
            maxTradeValue,
            policyExpiresAt,
            intentSigner
        }
    }
}

export class AgentWorker {
    private readonly dependencies: AgentWorkerDependencies
    private readonly options: AgentWorkerOptions
    private interval: ReturnType<typeof setInterval> | undefined
    private running = false
    private halted = false
    private inFlight = false
    private consecutiveFailures = 0
    private generation = 0
    private pendingIntent: AgentExecutionIntent | undefined

    constructor(
        dependencies: AgentWorkerDependencies,
        options: Partial<AgentWorkerOptions> = {}
    ) {
        this.dependencies = dependencies
        this.options = { ...DEFAULT_OPTIONS, ...options }
        if (!Number.isSafeInteger(this.options.intervalMs) || this.options.intervalMs < 250) {
            throw new Error("intervalMs must be an integer of at least 250ms")
        }
        if (
            !Number.isSafeInteger(this.options.maxConsecutiveFailures)
            || this.options.maxConsecutiveFailures < 1
        ) {
            throw new Error("maxConsecutiveFailures must be a positive integer")
        }
        if (
            !Number.isSafeInteger(this.options.maxMarketAgeMs)
            || this.options.maxMarketAgeMs < 1
            || this.options.maxMarketAgeMs > MAX_MARKET_AGE_MS
        ) {
            throw new Error("maxMarketAgeMs must be between 1 and 20000")
        }
    }

    get isRunning() {
        return this.running
    }

    get hasPendingIntent() {
        return this.pendingIntent !== undefined
    }

    getPendingIntent() {
        return this.pendingIntent
    }

    acknowledgeIntent(strategyId: string) {
        if (this.pendingIntent?.strategyId !== strategyId) return false
        this.dropIntent()
        return true
    }

    start() {
        if (this.running || this.halted) return
        this.running = true
        this.generation += 1
        this.interval = setInterval(() => {
            void this.evaluateOnce()
        }, this.options.intervalMs)
        void this.evaluateOnce()
    }

    stop() {
        this.running = false
        this.generation += 1
        if (this.interval !== undefined) clearInterval(this.interval)
        this.interval = undefined
        this.dropIntent()
    }

    async runOnce() {
        if (this.running) await this.evaluateOnce()
    }

    async evaluateOnce() {
        if (this.halted || this.inFlight) return
        this.inFlight = true
        const generation = this.generation
        try {
            for (const strategy of this.dependencies.strategies) {
                if (this.halted || generation !== this.generation) break
                await this.evaluate(strategy, generation)
            }
        } finally {
            this.inFlight = false
        }
    }

    private async evaluate(strategy: AgentStrategy, generation: number) {
        const timestamp = this.timestamp()
        let market: MarketSnapshot | undefined
        let validator: ValidatorSnapshot | undefined

        try {
            market = await this.dependencies.readMarket(strategy)
            validator = await this.dependencies.readValidator(strategy)
        } catch (error) {
            if (generation !== this.generation || this.halted) return
            await this.failCycle(strategy, timestamp, "RPC_FAILURE", error)
            return
        }
        if (generation !== this.generation || this.halted) return

        const remainingCapacity = MAX_ROLLING_VOLUME_BNB - validator.rollingVolume
        const telemetry = (
            reasonCode: AgentCycleReason,
            detail?: string,
            priceImpactBps?: number
        ): AgentCycleTelemetry => ({
            type: "agent_evaluation",
            strategyId: strategy.id,
            account: strategy.account,
            targetToken: strategy.targetToken,
            timestamp,
            currentPriceMicros: market?.priceMicros.toString(),
            cumulativeVolumeBnb: validator?.rollingVolume.toString(),
            attemptedTradeBnb: strategy.amountBnb.toString(),
            remainingCapacityBnb: (
                remainingCapacity > BigInt(0) ? remainingCapacity : BigInt(0)
            ).toString(),
            priceImpactBps,
            slippageBps: strategy.slippageBps,
            reasonCode,
            detail
        })

        if (market.observedAt > this.now() || this.now() - market.observedAt >= this.options.maxMarketAgeMs) {
            await this.failCycle(
                strategy,
                timestamp,
                "RPC_FAILURE",
                new Error("Market snapshot is stale or has a future timestamp"),
                market,
                validator
            )
            return
        }
        if (validator.paused) {
            this.rejectCycle(strategy, telemetry("CIRCUIT_BREAKER_PAUSED"))
            return
        }
        if (validator.revoked) {
            this.rejectCycle(strategy, telemetry("SESSION_REVOKED"))
            return
        }
        if (!validator.installed) {
            this.rejectCycle(strategy, telemetry("SESSION_NOT_INSTALLED"))
            return
        }
        if (
            !validator.policyConfigured || /^0x0{64}$/i.test(validator.policyHash)
                || /^0x0{40}$/i.test(validator.intentSigner)
        ) {
            this.rejectCycle(strategy, telemetry("POLICY_NOT_CONFIGURED"))
            return
        }
        if (validator.policyExpiresAt * BigInt(1000) <= BigInt(this.now())) {
            this.rejectCycle(strategy, telemetry("POLICY_EXPIRED"))
            return
        }
        if (strategy.amountBnb <= BigInt(0) || strategy.amountBnb > MAX_TRADE_BNB) {
            this.rejectCycle(strategy, telemetry("TRADE_CAP_EXCEEDED"))
            return
        }
        if (strategy.amountBnb > validator.maxTradeValue) {
            this.rejectCycle(strategy, telemetry("TRADE_CAP_EXCEEDED"))
            return
        }
        if (
            validator.rollingVolume < BigInt(0)
            || validator.rollingVolume > MAX_ROLLING_VOLUME_BNB
            || strategy.amountBnb > remainingCapacity
        ) {
            this.rejectCycle(strategy, telemetry("CAP_EXCEEDED"))
            return
        }
        if (market.priceMicros > strategy.entryPriceMicros) {
            this.record(telemetry("TRIGGER_NOT_MET"))
            this.consecutiveFailures = 0
            return
        }
        if (this.pendingIntent) {
            this.record(telemetry("INTENT_PENDING"))
            return
        }

        let quote: ReturnType<typeof calculateDynamicQuote>
        try {
            quote = calculateDynamicQuote(
                strategy.amountBnb,
                market.reserves,
                strategy.slippageBps,
                strategy.maxPriceImpactBps
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : "Quote calculation failed"
            this.rejectCycle(
                strategy,
                telemetry(
                    message.includes("Price impact") ? "SLIPPAGE_HIGH" : "RPC_FAILURE",
                    message
                ),
                message.includes("Price impact")
            )
            return
        }

        this.record(telemetry("VALIDATOR_PASS", undefined, quote.priceImpactBps))
        this.consecutiveFailures = 0
        try {
            const intent: AgentExecutionIntent = {
                strategyId: strategy.id,
                account: strategy.account,
                targetToken: strategy.targetToken,
                amountBnb: strategy.amountBnb,
                amountOutMin: quote.amountOutMin,
                priceImpactBps: quote.priceImpactBps,
                slippageBps: strategy.slippageBps,
                maxPriceImpactBps: strategy.maxPriceImpactBps,
                sourcePriceMicros: market.priceMicros,
                createdAt: new Date(market.receivedAt ?? market.observedAt).toISOString(),
                policyHash: validator.policyHash
            }
            if (generation !== this.generation || this.halted) return
            this.pendingIntent = intent
            await this.dependencies.onIntent?.(intent)
        } catch (error) {
            if (generation !== this.generation || this.halted) return
            await this.failCycle(strategy, timestamp, "RPC_FAILURE", error, market, validator)
        }
    }

    private rejectCycle(
        strategy: AgentStrategy,
        event: AgentCycleTelemetry,
        countsTowardPanic = true
    ) {
        this.record(event)
        if (countsTowardPanic) this.countFailure(strategy, event.detail ?? event.reasonCode)
        else this.consecutiveFailures = 0
    }

    private async failCycle(
        strategy: AgentStrategy,
        timestamp: string,
        reasonCode: "RPC_FAILURE",
        error: unknown,
        market?: MarketSnapshot,
        validator?: ValidatorSnapshot
    ) {
        const detail = error instanceof Error ? error.message : "Unknown RPC or worker error"
        this.record({
            type: "agent_evaluation",
            strategyId: strategy.id,
            account: strategy.account,
            targetToken: strategy.targetToken,
            timestamp,
            currentPriceMicros: market?.priceMicros.toString(),
            cumulativeVolumeBnb: validator?.rollingVolume.toString(),
            attemptedTradeBnb: strategy.amountBnb.toString(),
            remainingCapacityBnb: validator
                ? (MAX_ROLLING_VOLUME_BNB > validator.rollingVolume
                    ? MAX_ROLLING_VOLUME_BNB - validator.rollingVolume
                    : BigInt(0)).toString()
                : undefined,
            slippageBps: strategy.slippageBps,
            reasonCode,
            detail
        })
        this.countFailure(strategy, detail)
    }

    private countFailure(strategy: AgentStrategy, detail: string) {
        this.consecutiveFailures += 1
        if (this.consecutiveFailures < this.options.maxConsecutiveFailures) return
        this.running = false
        this.halted = true
        this.generation += 1
        if (this.interval !== undefined) clearInterval(this.interval)
        this.interval = undefined
        this.dropIntent()
        const timestamp = this.timestamp()
        this.record({
            type: "agent_evaluation",
            strategyId: strategy.id,
            account: strategy.account,
            targetToken: strategy.targetToken,
            timestamp,
            attemptedTradeBnb: strategy.amountBnb.toString(),
            slippageBps: strategy.slippageBps,
            reasonCode: "WORKER_PANIC_STOP",
            detail
        })
        void Promise.resolve(this.dependencies.alert({
            priority: "high",
            reasonCode: "WORKER_PANIC_STOP",
            message: `Agent worker halted after ${this.consecutiveFailures} consecutive policy/RPC failures: ${detail}`,
            timestamp
        })).catch(error => {
            console.error("Failed to deliver agent panic-stop alert", error)
        })
    }

    reportExecutionFailure(
        strategyId: string,
        reasonCode: Extract<
            AgentCycleReason,
            "BUNDLER_MEMPOOL_REJECTED" | "ONCHAIN_EXECUTION_REVERTED" | "USEROP_RECEIPT_TIMEOUT" | "RPC_FAILURE"
        >,
        detail: string
    ) {
        const strategy = this.dependencies.strategies.find(item => item.id === strategyId)
        if (!strategy) {
            throw new Error(`Unknown agent strategy ${strategyId}`)
        }
        if (this.halted) return
        this.record({
            type: "agent_evaluation",
            strategyId,
            account: strategy.account,
            targetToken: strategy.targetToken,
            timestamp: this.timestamp(),
            attemptedTradeBnb: strategy.amountBnb.toString(),
            slippageBps: strategy.slippageBps,
            reasonCode,
            detail
        })
        this.countFailure(strategy, `${reasonCode}: ${detail}`)
    }

    private dropIntent() {
        this.pendingIntent = undefined
    }

    private record(event: AgentCycleTelemetry) {
        this.dependencies.log(event)
    }

    private now() {
        return (this.dependencies.now ?? Date.now)()
    }

    private timestamp() {
        return new Date(this.now()).toISOString()
    }
}
