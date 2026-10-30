import type { KernelValidator } from "@zerodev/sdk"
import type { Signer } from "@zerodev/sdk/types"
import type { Address, Client, Hex } from "viem"
import { getAddress } from "viem"
import { readContract } from "viem/actions"
import {
    buildAgentBuyCall,
    createAgentSmartAccountClient,
    encodeAgentBuyCall,
    getAgentSmartAccountConfig,
    type AgentSmartAccountConfig
} from "../lib/smartAccount.ts"
import {
    MAX_ROLLING_VOLUME_BNB,
    MAX_TRADE_BNB,
    type AgentExecutionIntent
} from "./agentWorker.ts"

export type AgentExecutorErrorCode =
    | "LIVE_SUBMISSION_DISABLED"
    | "MAINNET_SUBMISSION_BLOCKED"
    | "INTENT_INVALID"
    | "INTENT_STALE"
    | "VALIDATOR_PREFLIGHT_FAILED"
    | "BUNDLER_MEMPOOL_REJECTED"
    | "ONCHAIN_EXECUTION_REVERTED"
    | "USEROP_RECEIPT_TIMEOUT"
    | "RPC_FAILURE"

export class AgentExecutorError extends Error {
    readonly code: AgentExecutorErrorCode
    readonly cause?: unknown

    constructor(
        code: AgentExecutorErrorCode,
        message: string,
        cause?: unknown
    ) {
        super(message)
        this.name = "AgentExecutorError"
        this.code = code
        this.cause = cause
    }
}

export type AgentExecutorTelemetry = {
    event: "userop_prepared" | "userop_submitted" | "userop_confirmed" | "userop_failed"
    code?: AgentExecutorErrorCode
    strategyId: string
    account: Address
    targetToken: Address
    amountBnb: string
    timestamp: string
    userOperationHash?: Hex
    transactionHash?: Hex
    gasUsed?: string
    gasCostWei?: string
    priceImpactBps?: number
    error?: string
}

export type AgentAuthorization = {
    ownerValidator: KernelValidator
    sessionKeySigner: Signer
}

type AgentAccountClient = Awaited<ReturnType<typeof createAgentSmartAccountClient>>["client"]
type AgentReceipt = Awaited<ReturnType<AgentAccountClient["waitForUserOperationReceipt"]>>

export type AgentExecutorDependencies = {
    isLiveEnabled?: () => boolean
    getConfig?: () => AgentSmartAccountConfig
    resolveAuthorization: (intent: AgentExecutionIntent) => Promise<AgentAuthorization>
    createAccountClient?: typeof createAgentSmartAccountClient
    readValidator?: (client: Client, account: Address) => Promise<{
        paused: boolean
        installed: boolean
        revoked: boolean
        rollingVolume: bigint
    }>
    buildBuyCall?: typeof buildAgentBuyCall
    encodeBuyCall?: typeof encodeAgentBuyCall
    log?: (event: AgentExecutorTelemetry) => void
    onFailure?: (
        intent: AgentExecutionIntent,
        code: AgentExecutorErrorCode,
        error: Error
    ) => void
    now?: () => number
    maxIntentAgeMs?: number
    receiptTimeoutMs?: number
    receiptPollingIntervalMs?: number
}

const VALIDATOR_ABI = [
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
    }
] as const

const DEFAULT_MAX_INTENT_AGE_MS = 30_000
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000
const DEFAULT_RECEIPT_POLLING_INTERVAL_MS = 2_000

export function isLiveUserOperationSubmissionEnabled(
    env: NodeJS.ProcessEnv = process.env
) {
    return env.ENABLE_LIVE_USEROP_SUBMISSION === "true"
}

export async function readAgentValidatorState(client: Client, account: Address) {
    const config = getAgentSmartAccountConfig()
    const [paused, installed, revoked, rollingVolume] = await Promise.all([
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "paused"
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "isInitialized",
            args: [account]
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "isRevoked",
            args: [account]
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "getEffectiveRollingVolume",
            args: [account]
        })
    ])
    return { paused, installed, revoked, rollingVolume }
}

export class AgentExecutor {
    private readonly dependencies: AgentExecutorDependencies
    private readonly now: () => number
    private readonly maxIntentAgeMs: number
    private readonly receiptTimeoutMs: number
    private readonly receiptPollingIntervalMs: number

    constructor(dependencies: AgentExecutorDependencies) {
        this.dependencies = dependencies
        this.now = dependencies.now ?? Date.now
        this.maxIntentAgeMs = dependencies.maxIntentAgeMs ?? DEFAULT_MAX_INTENT_AGE_MS
        this.receiptTimeoutMs = dependencies.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS
        this.receiptPollingIntervalMs =
            dependencies.receiptPollingIntervalMs ?? DEFAULT_RECEIPT_POLLING_INTERVAL_MS
        for (const [name, value] of [
            ["maxIntentAgeMs", this.maxIntentAgeMs],
            ["receiptTimeoutMs", this.receiptTimeoutMs],
            ["receiptPollingIntervalMs", this.receiptPollingIntervalMs]
        ] as const) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new Error(`${name} must be a positive safe integer`)
            }
        }
    }

    async executeUserOperation(intent: AgentExecutionIntent) {
        const metadata = {
            strategyId: intent.strategyId,
            account: intent.account,
            targetToken: intent.targetToken,
            amountBnb: intent.amountBnb.toString()
        }
        const log = this.dependencies.log ?? (event => {
            const method = event.event === "userop_failed" ? console.error : console.info
            method(JSON.stringify(event))
        })

        try {
            if (!(this.dependencies.isLiveEnabled ?? isLiveUserOperationSubmissionEnabled)()) {
                throw new AgentExecutorError(
                    "LIVE_SUBMISSION_DISABLED",
                    "Live UserOperation submission is disabled; set ENABLE_LIVE_USEROP_SUBMISSION=true to enable it"
                )
            }
            const config = this.dependencies.getConfig?.() ?? getAgentSmartAccountConfig()
            if (config.chain.id !== 97) {
                throw new AgentExecutorError(
                    "MAINNET_SUBMISSION_BLOCKED",
                    "This executor is restricted to BSC testnet (chain ID 97)"
                )
            }
            this.validateIntent(intent, config)

            const authorization = await this.dependencies.resolveAuthorization(intent)
            const { account, client } = await (
                this.dependencies.createAccountClient ?? createAgentSmartAccountClient
            )(
                authorization.ownerValidator,
                authorization.sessionKeySigner,
                config
            )
            if (getAddress(account.address) !== getAddress(intent.account)) {
                throw new AgentExecutorError(
                    "INTENT_INVALID",
                    `Resolved smart account ${account.address} does not match intent account ${intent.account}`
                )
            }

            const validator = await (
                this.dependencies.readValidator ?? readAgentValidatorState
            )(client.client, account.address)
            this.validateValidatorState(validator, intent.amountBnb)

            const call = await (this.dependencies.buildBuyCall ?? buildAgentBuyCall)(
                client.client,
                {
                    accountAddress: account.address,
                    amountBnb: intent.amountBnb,
                    slippageBps: intent.slippageBps,
                    maxPriceImpactBps: intent.maxPriceImpactBps
                },
                config
            )
            const amountOutMin =
                intent.amountOutMin > call.quote.amountOutMin
                    ? intent.amountOutMin
                    : call.quote.amountOutMin
            const safeCall = amountOutMin === call.quote.amountOutMin
                ? call
                : {
                    ...call,
                    ...(this.dependencies.encodeBuyCall ?? encodeAgentBuyCall)(
                        {
                            accountAddress: account.address,
                            amountBnb: intent.amountBnb
                        },
                        amountOutMin,
                        config
                    ),
                    quote: { ...call.quote, amountOutMin }
                }

            log({
                event: "userop_prepared",
                ...metadata,
                timestamp: this.timestamp(),
                priceImpactBps: safeCall.quote.priceImpactBps
            })

            let userOperationHash: Hex
            try {
                userOperationHash = await client.sendUserOperation({
                    calls: [{
                        to: safeCall.to,
                        value: safeCall.value,
                        data: safeCall.data
                    }]
                })
            } catch (error) {
                throw new AgentExecutorError(
                    "BUNDLER_MEMPOOL_REJECTED",
                    `Bundler rejected UserOperation during submission: ${errorMessage(error)}`,
                    error
                )
            }

            log({
                event: "userop_submitted",
                ...metadata,
                timestamp: this.timestamp(),
                userOperationHash,
                priceImpactBps: safeCall.quote.priceImpactBps
            })

            let receipt: AgentReceipt
            try {
                receipt = await client.waitForUserOperationReceipt({
                    hash: userOperationHash,
                    timeout: this.receiptTimeoutMs,
                    pollingInterval: this.receiptPollingIntervalMs,
                    retryCount: Math.max(
                        1,
                        Math.ceil(this.receiptTimeoutMs / this.receiptPollingIntervalMs)
                    )
                })
            } catch (error) {
                const message = errorMessage(error)
                const code = /timeout|timed out/i.test(message)
                    ? "USEROP_RECEIPT_TIMEOUT"
                    : "RPC_FAILURE"
                throw new AgentExecutorError(
                    code,
                    `Failed while polling UserOperation receipt: ${message}`,
                    error
                )
            }
            if (!receipt.success) {
                throw new AgentExecutorError(
                    "ONCHAIN_EXECUTION_REVERTED",
                    `UserOperation was included but execution reverted: ${receipt.reason ?? "unknown revert reason"}`
                )
            }

            const result = {
                userOperationHash,
                transactionHash: receipt.receipt.transactionHash,
                receipt,
                gasUsed: receipt.actualGasUsed,
                gasCostWei: receipt.actualGasCost,
                status: "success" as const
            }
            log({
                event: "userop_confirmed",
                ...metadata,
                timestamp: this.timestamp(),
                userOperationHash,
                transactionHash: result.transactionHash,
                gasUsed: result.gasUsed.toString(),
                gasCostWei: result.gasCostWei.toString(),
                priceImpactBps: safeCall.quote.priceImpactBps
            })
            return result
        } catch (error) {
            const executorError = error instanceof AgentExecutorError
                ? error
                : new AgentExecutorError(
                    "RPC_FAILURE",
                    errorMessage(error),
                    error
                )
            log({
                event: "userop_failed",
                code: executorError.code,
                ...metadata,
                timestamp: this.timestamp(),
                error: executorError.message
            })
            if (executorError.code !== "LIVE_SUBMISSION_DISABLED") {
                this.dependencies.onFailure?.(intent, executorError.code, executorError)
            }
            throw executorError
        }
    }

    private validateIntent(intent: AgentExecutionIntent, config: AgentSmartAccountConfig) {
        const createdAt = Date.parse(intent.createdAt)
        if (
            !intent.strategyId
            || !Number.isFinite(createdAt)
            || !/^0x[0-9a-f]{40}$/i.test(intent.account)
            || !/^0x[0-9a-f]{40}$/i.test(intent.targetToken)
            || getAddress(intent.targetToken) !== getAddress(config.targetTokenAddress)
            || intent.amountBnb <= BigInt(0)
            || intent.amountBnb > MAX_TRADE_BNB
            || intent.amountOutMin <= BigInt(0)
            || !Number.isInteger(intent.priceImpactBps)
            || intent.priceImpactBps < 0
            || !Number.isInteger(intent.slippageBps)
            || intent.slippageBps < 1
            || intent.slippageBps > 500
            || !Number.isInteger(intent.maxPriceImpactBps)
            || intent.maxPriceImpactBps < 1
            || intent.maxPriceImpactBps > 500
            || intent.priceImpactBps > intent.maxPriceImpactBps
        ) {
            throw new AgentExecutorError("INTENT_INVALID", "Execution intent failed validation")
        }
        if (createdAt > this.now() || this.now() - createdAt > this.maxIntentAgeMs) {
            throw new AgentExecutorError("INTENT_STALE", "Execution intent is stale")
        }
    }

    private validateValidatorState(
        validator: {
            paused: boolean
            installed: boolean
            revoked: boolean
            rollingVolume: bigint
        },
        amountBnb: bigint
    ) {
        if (
            validator.paused
            || !validator.installed
            || validator.revoked
            || validator.rollingVolume < BigInt(0)
            || validator.rollingVolume > MAX_ROLLING_VOLUME_BNB
            || amountBnb > MAX_ROLLING_VOLUME_BNB - validator.rollingVolume
        ) {
            throw new AgentExecutorError(
                "VALIDATOR_PREFLIGHT_FAILED",
                "Validator pause, session state, or rolling-cap check rejected the intent"
            )
        }
    }

    private timestamp() {
        return new Date(this.now()).toISOString()
    }
}

export function createWorkerFailureReporter(
    worker: {
        reportExecutionFailure: (
            strategyId: string,
            reasonCode: "BUNDLER_MEMPOOL_REJECTED" | "ONCHAIN_EXECUTION_REVERTED" | "USEROP_RECEIPT_TIMEOUT" | "RPC_FAILURE",
            detail: string
        ) => void
    }
) {
    return (
        intent: AgentExecutionIntent,
        code: AgentExecutorErrorCode,
        error: Error
    ) => {
        if (
            code === "BUNDLER_MEMPOOL_REJECTED"
            || code === "ONCHAIN_EXECUTION_REVERTED"
            || code === "USEROP_RECEIPT_TIMEOUT"
            || code === "RPC_FAILURE"
        ) {
            worker.reportExecutionFailure(intent.strategyId, code, error.message)
        }
    }
}

function errorMessage(error: unknown) {
    if (error instanceof Error) {
        const candidate = error as Error & { shortMessage?: string; details?: string }
        return candidate.shortMessage ?? candidate.details ?? candidate.message
    }
    return "Unknown UserOperation error"
}
