import { pathToFileURL } from "node:url"
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
    createWorkerFailureReporter
} from "../services/agentExecutor.ts"
import {
    AgentWorker,
    createViemValidatorReader,
    MAX_TRADE_BNB,
    type AgentStrategy,
    type MarketSnapshot
} from "../services/agentWorker.ts"
import { closeIntentNonceTracker } from "../services/agentIntentNonceTracker.ts"
import {
    getAddress,
    isAddress,
    parseEther,
    type Address
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
        const { id, account, targetToken, amountBnb, entryPriceMicros, slippageBps, maxPriceImpactBps } = value
        if (
            typeof id !== "string" || !id.trim()
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

async function main() {
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
    void main().catch(error => {
        console.error("Agent worker failed to start:", error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    })
}
