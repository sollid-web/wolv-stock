import type { KernelValidator } from "@zerodev/sdk"
import type { Signer } from "@zerodev/sdk/types"
import { toECDSASigner } from "@zerodev/permissions/signers"
import type { Address, Client, Hex } from "viem"
import { concatHex, encodeAbiParameters, getAddress } from "viem"
import { readContract } from "viem/actions"
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts"
import {
    buildAgentBuyCall,
    createAgentSmartAccountClient,
    encodeAgentBuyCall,
    AGENT_SWAP_DEADLINE_SECONDS,
    getAgentSmartAccountConfig,
    type AgentSmartAccountConfig
} from "../lib/smartAccount.ts"
import {
    MAX_ROLLING_VOLUME_BNB,
    MAX_TRADE_BNB,
    type AgentExecutionIntent
} from "./agentWorker.ts"
import {
    AgentIntentNonceError,
    getNextIntentNonce
} from "./agentIntentNonceTracker.ts"

export type AgentExecutorErrorCode =
    | "LIVE_SUBMISSION_DISABLED"
    | "MAINNET_SUBMISSION_BLOCKED"
    | "INTENT_INVALID"
    | "INTENT_STALE"
    | "INTENT_NONCE_UNAVAILABLE"
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

type AgentIntentSigner = Awaited<ReturnType<typeof toECDSASigner>>

type AgentAccountClient = Awaited<ReturnType<typeof createAgentSmartAccountClient>>["client"]
type AgentReceipt = Awaited<ReturnType<AgentAccountClient["waitForUserOperationReceipt"]>>

export type AgentExecutorDependencies = {
    isLiveEnabled?: () => boolean
    getConfig?: () => AgentSmartAccountConfig
    resolveAuthorization: (intent: AgentExecutionIntent) => Promise<AgentAuthorization>
    createAccountClient?: typeof createAgentSmartAccountClient
    createIntentSigner?: (signer: Signer) => Promise<AgentIntentSigner>
    readValidator?: (client: Client, account: Address) => Promise<{
        paused: boolean
        installed: boolean
        revoked: boolean
        rollingVolume: bigint
        policyConfigured?: boolean
        policyHash?: Hex
        maxTradeValue?: bigint
        expiresAt?: bigint
        intentSigner?: Address
        entryPriceMicros?: bigint
        maxSlippageBps?: number
        maxPriceImpactBps?: number
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
    getNextIntentNonce?: (smartAccount: Address) => Promise<Hex>
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
    },
    {
        type: "function",
        name: "getAccountRiskPolicy",
        inputs: [{ name: "account", type: "address" }],
        outputs: [
            { name: "entryPriceMicros", type: "uint64" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "maxPriceImpactBps", type: "uint16" }
        ],
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

const TRADE_INTENT_TYPES = {
    TradeIntent: [
        { name: "smartAccount", type: "address" },
        { name: "policyHash", type: "bytes32" },
        { name: "router", type: "address" },
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMin", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "slippageBps", type: "uint16" },
        { name: "maxPriceImpactBps", type: "uint16" },
        { name: "validUntil", type: "uint64" },
        { name: "nonce", type: "bytes32" }
    ]
} as const

const DEFAULT_MAX_INTENT_AGE_MS = 20_000
const INTENT_VALIDITY_SECONDS = 20
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000
const DEFAULT_RECEIPT_POLLING_INTERVAL_MS = 2_000

export function isLiveUserOperationSubmissionEnabled(
    env: NodeJS.ProcessEnv = process.env
) {
    return env.ENABLE_LIVE_USEROP_SUBMISSION === "true"
        && env.WOLV_AUTONOMOUS_TRADING_ENABLED === "true"
}

export function resolveAgentExecutionNetwork(
    configuredChainId: number,
    env: NodeJS.ProcessEnv = process.env,
):
    | { allowed: true; chainId: 97 | 56 }
    | { allowed: false; reason: string } {
    if (env.WOLV_AUTONOMOUS_TRADING_ENABLED !== "true") {
        return { allowed: false, reason: "Autonomous trading is disabled by the master safety gate." };
    }
    if (configuredChainId === 97) {
        return env.ENABLE_LIVE_USEROP_SUBMISSION === "true"
            ? { allowed: true, chainId: 97 }
            : { allowed: false, reason: "Live BSC Testnet submission is disabled." };
    }
    if (configuredChainId === 56) {
        if (env.ENABLE_LIVE_USEROP_SUBMISSION !== "true") {
            return { allowed: false, reason: "Live submission is disabled." };
        }
        if (env.ENABLE_MAINNET_AGENT_TRADING !== "true") {
            return { allowed: false, reason: "Separate mainnet trading authorization is disabled." };
        }
        if (env.MAINNET_AGENT_TRADING_ACK !== "I_ACCEPT_AUTONOMOUS_MAINNET_RISK") {
            return { allowed: false, reason: "Mainnet autonomous-trading acknowledgement is missing." };
        }
        return { allowed: true, chainId: 56 };
    }
    return { allowed: false, reason: `Unsupported agent execution chain ID: ${configuredChainId}.` };
}

export async function readAgentValidatorState(client: Client, account: Address) {
    const config = getAgentSmartAccountConfig()
    const [paused, installed, revoked, rollingVolume, accountPolicy, riskPolicy] = await Promise.all([
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
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "getAccountPolicy",
            args: [account]
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: VALIDATOR_ABI,
            functionName: "getAccountRiskPolicy",
            args: [account]
        })
    ])
    const [policyConfigured, policyHash, maxTradeValue, expiresAt, intentSigner] = accountPolicy
    const [entryPriceMicros, maxSlippageBps, maxPriceImpactBps] = riskPolicy
    return {
        paused,
        installed,
        revoked,
        rollingVolume,
        policyConfigured,
        policyHash,
        maxTradeValue,
        expiresAt,
        intentSigner,
        entryPriceMicros,
        maxSlippageBps,
        maxPriceImpactBps
    }
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
        if (this.maxIntentAgeMs > DEFAULT_MAX_INTENT_AGE_MS) {
            throw new Error("maxIntentAgeMs cannot exceed 20000ms")
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
                    "Live UserOperation submission is disabled; set WOLV_AUTONOMOUS_TRADING_ENABLED=true and ENABLE_LIVE_USEROP_SUBMISSION=true to enable it"
                )
            }
            const config = this.dependencies.getConfig?.() ?? getAgentSmartAccountConfig()
            const networkGate = resolveAgentExecutionNetwork(config.chain.id, {
                ...process.env,
                ENABLE_LIVE_USEROP_SUBMISSION: "true",
            })
            if (!networkGate.allowed) {
                throw new AgentExecutorError(
                    "MAINNET_SUBMISSION_BLOCKED",
                    networkGate.reason
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
            const delegatedSigner = this.dependencies.createIntentSigner
                ? await this.dependencies.createIntentSigner(authorization.sessionKeySigner)
                : await toECDSASigner({ signer: authorization.sessionKeySigner })
            const intentSigner = getAddress(delegatedSigner.getSignerData())
            this.validateValidatorState(validator, intent, intentSigner)

            const expiresAt = validator.expiresAt
            if (expiresAt === undefined) {
                throw new AgentExecutorError(
                    "VALIDATOR_PREFLIGHT_FAILED",
                    "On-chain policy expiry is unavailable."
                )
            }
            const nowSeconds = Math.floor(this.now() / 1000)
            const validUntil = Math.min(nowSeconds + INTENT_VALIDITY_SECONDS, Number(expiresAt))
            const deadline = Math.min(
                nowSeconds + AGENT_SWAP_DEADLINE_SECONDS,
                validUntil
            )
            if (!Number.isSafeInteger(validUntil) || validUntil <= nowSeconds) {
                throw new AgentExecutorError(
                    "INTENT_STALE",
                    "On-chain policy expires before this intent can be submitted."
                )
            }
            if (!Number.isSafeInteger(deadline) || deadline <= nowSeconds) {
                throw new AgentExecutorError(
                    "INTENT_STALE",
                    "On-chain policy expires before the swap deadline."
                )
            }
            const call = await (this.dependencies.buildBuyCall ?? buildAgentBuyCall)(
                client.client,
                {
                    accountAddress: account.address,
                    amountBnb: intent.amountBnb,
                    slippageBps: intent.slippageBps,
                    maxPriceImpactBps: intent.maxPriceImpactBps,
                    deadline
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
                            amountBnb: intent.amountBnb,
                            deadline
                        },
                        amountOutMin,
                        config
                    ),
                    quote: { ...call.quote, amountOutMin }
                }
            let intentNonce: Hex
            try {
                intentNonce = await (this.dependencies.getNextIntentNonce ?? getNextIntentNonce)(
                    account.address
                )
            } catch (error) {
                throw new AgentExecutorError(
                    "INTENT_NONCE_UNAVAILABLE",
                    error instanceof AgentIntentNonceError
                        ? error.message
                        : "Persistent intent nonce allocation failed.",
                    error
                )
            }
            const signedIntent = {
                smartAccount: getAddress(account.address),
                policyHash: intent.policyHash,
                router: getAddress(config.routerAddress),
                tokenIn: getAddress(config.wrappedNativeAddress),
                tokenOut: getAddress(intent.targetToken),
                recipient: getAddress(account.address),
                amountIn: intent.amountBnb,
                amountOutMin: safeCall.quote.amountOutMin,
                deadline: BigInt(deadline),
                slippageBps: intent.slippageBps,
                maxPriceImpactBps: intent.maxPriceImpactBps,
                validUntil: BigInt(validUntil),
                nonce: intentNonce
            }
            let intentSignature: Hex
            try {
                intentSignature = await signTradeIntent(
                    delegatedSigner,
                    {
                        domain: {
                            name: "WolvTradingAgent",
                            version: "1",
                            chainId: config.chain.id,
                            verifyingContract: config.policyHookAddress
                        },
                        types: TRADE_INTENT_TYPES,
                        primaryType: "TradeIntent",
                        message: signedIntent
                    }
                )
            } catch (error) {
                throw new AgentExecutorError(
                    "INTENT_INVALID",
                    `Delegated intent signer could not sign the on-chain authorization: ${errorMessage(error)}`,
                    error
                )
            }
            this.validateIntent(intent, config)
            const submissionTimeSeconds = Math.floor(this.now() / 1000)
            if (submissionTimeSeconds >= validUntil || submissionTimeSeconds >= deadline) {
                throw new AgentExecutorError(
                    "INTENT_STALE",
                    "Execution intent expired before UserOperation submission."
                )
            }
            const intentEnvelope = encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "uint64" },
                    { type: "uint16" },
                    { type: "uint16" },
                    { type: "bytes" }
                ],
                [
                    intent.policyHash,
                    intentNonce,
                    BigInt(validUntil),
                    intent.slippageBps,
                    intent.maxPriceImpactBps,
                    intentSignature
                ]
            )
            const authorizedCall = {
                ...safeCall,
                data: concatHex([safeCall.data, intentEnvelope])
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
                        to: authorizedCall.to,
                        value: authorizedCall.value,
                        data: authorizedCall.data
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
            || !/^0x[0-9a-f]{64}$/i.test(intent.policyHash)
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
            || intent.maxPriceImpactBps > 300
            || intent.priceImpactBps > intent.maxPriceImpactBps
        ) {
            throw new AgentExecutorError("INTENT_INVALID", "Execution intent failed validation")
        }
        if (createdAt > this.now() || this.now() - createdAt >= this.maxIntentAgeMs) {
            throw new AgentExecutorError("INTENT_STALE", "Execution intent is stale")
        }
    }

    private validateValidatorState(
        validator: {
            paused: boolean
            installed: boolean
            revoked: boolean
            rollingVolume: bigint
            policyConfigured?: boolean
            policyHash?: Hex
            maxTradeValue?: bigint
            expiresAt?: bigint
            intentSigner?: Address
            entryPriceMicros?: bigint
            maxSlippageBps?: number
            maxPriceImpactBps?: number
        },
        intent: AgentExecutionIntent,
        signer: Address
    ) {
        const amountBnb = intent.amountBnb
        const policyExpired = validator.policyConfigured === true &&
            (validator.expiresAt === undefined
                || validator.expiresAt === BigInt(0)
                || validator.expiresAt * BigInt(1000) <= BigInt(this.now()))
        const policyCapExceeded = validator.policyConfigured === true &&
            (validator.maxTradeValue === undefined || amountBnb > validator.maxTradeValue)
        let expectedPolicyHash: Hex | null = null
        if (
            validator.policyConfigured === true
            && validator.maxTradeValue !== undefined
            && validator.expiresAt !== undefined
            && validator.intentSigner !== undefined
        ) {
            try {
                expectedPolicyHash = hashAgentPolicy({
                    strategyId: intent.strategyId,
                    ownerAddress: intent.ownerAddress,
                    account: intent.account,
                    targetToken: intent.targetToken,
                    maxTradeValue: validator.maxTradeValue,
                    expiresAt: validator.expiresAt,
                    intentSigner: validator.intentSigner,
                    amountBnb: intent.amountBnb,
                    entryPriceMicros: intent.entryPriceMicros,
                    slippageBps: intent.slippageBps,
                    maxPriceImpactBps: intent.maxPriceImpactBps
                })
            } catch {
                expectedPolicyHash = null
            }
        }
        const policyHashMismatch = validator.policyConfigured === true &&
            (!intent.policyHash || !validator.policyHash || !expectedPolicyHash ||
                intent.policyHash.toLowerCase() !== validator.policyHash.toLowerCase() ||
                expectedPolicyHash.toLowerCase() !== validator.policyHash.toLowerCase())
        const intentSignerMismatch = !validator.intentSigner
            || !/^0x[0-9a-f]{40}$/i.test(validator.intentSigner)
            || getAddress(validator.intentSigner) !== getAddress(signer)
        const riskPolicyMismatch =
            validator.entryPriceMicros !== intent.entryPriceMicros
            || validator.maxSlippageBps !== intent.slippageBps
            || validator.maxPriceImpactBps !== intent.maxPriceImpactBps
        if (
            validator.paused
            || !validator.installed
            || validator.revoked
            || validator.rollingVolume < BigInt(0)
            || validator.rollingVolume > MAX_ROLLING_VOLUME_BNB
            || amountBnb > MAX_ROLLING_VOLUME_BNB - validator.rollingVolume
            || policyExpired
            || policyCapExceeded
            || policyHashMismatch
            || intentSignerMismatch
            || riskPolicyMismatch
            || validator.policyConfigured !== true
        ) {
            throw new AgentExecutorError(
                "VALIDATOR_PREFLIGHT_FAILED",
                "Validator policy, signer, pause, session state, or rolling-cap check rejected the intent"
            )
        }
    }

    private timestamp() {
        return new Date(this.now()).toISOString()
    }
}

async function signTradeIntent(
    signer: Awaited<ReturnType<typeof toECDSASigner>>,
    typedData: {
        domain: {
            name: string
            version: string
            chainId: number
            verifyingContract: Address
        }
        types: typeof TRADE_INTENT_TYPES
        primaryType: "TradeIntent"
        message: {
            smartAccount: Address
            policyHash: Hex
            router: Address
            tokenIn: Address
            tokenOut: Address
            recipient: Address
            amountIn: bigint
            amountOutMin: bigint
            deadline: bigint
            slippageBps: number
            maxPriceImpactBps: number
            validUntil: bigint
            nonce: Hex
        }
    }
): Promise<Hex> {
    return signer.account.signTypedData(typedData)
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
            || code === "INTENT_NONCE_UNAVAILABLE"
        ) {
            worker.reportExecutionFailure(
                intent.strategyId,
                code === "INTENT_NONCE_UNAVAILABLE" ? "RPC_FAILURE" : code,
                error.message
            )
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
