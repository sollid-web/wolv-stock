import "server-only"
import {
    KERNEL_V3_1,
    getEntryPoint
} from "@zerodev/sdk/constants"
import {
    createKernelAccount,
    toKernelPluginManager
} from "@zerodev/sdk/accounts"
import { createKernelAccountClient } from "@zerodev/sdk/clients"
import type {
    KernelPluginManager,
    KernelValidator,
    KernelValidatorHook
} from "@zerodev/sdk"
import type { Signer } from "@zerodev/sdk/types"
import {
    toPermissionValidator
} from "@zerodev/permissions"
import {
    CallPolicyVersion,
    CallType,
    toCallPolicy
} from "@zerodev/permissions/policies"
import { toECDSASigner } from "@zerodev/permissions/signers"
import {
    type Address,
    type Client,
    type Hex,
    concatHex,
    createPublicClient,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    http,
    isAddress,
    parseEther
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { getBytecode, getChainId, readContract } from "viem/actions"
import { bsc, bscTestnet } from "viem/chains"
import { resolvePublicRpcUrl } from "./publicRpcUrl.ts"

const BUY_SELECTOR = "0x7ff36ab5" as const
const ENTRY_POINT = getEntryPoint("0.7")
const MAX_TRADE_VALUE = parseEther("0.5")
const SESSION_VALIDITY_SECONDS = 7 * 24 * 60 * 60
const SWAP_DEADLINE_SECONDS = 5 * 60
const DEFAULT_SLIPPAGE_BPS = 100
const MAX_SLIPPAGE_BPS = 500
const DEFAULT_MAX_PRICE_IMPACT_BPS = 300
const MAX_PRICE_IMPACT_BPS = 500
const FEE_NUMERATOR = BigInt(997)
const FEE_DENOMINATOR = BigInt(1000)
const BPS = BigInt(10_000)
const MAINNET_WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")
const TESTNET_WBNB = getAddress("0xae13d989dac2f0debff460ac112a837c89baa7cd")

const routerBuyAbi = [
    {
        type: "function",
        name: "swapExactETHForTokens",
        stateMutability: "payable",
        inputs: [
            { name: "amountOutMin", type: "uint256" },
            { name: "path", type: "address[]" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" }
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }]
    }
] as const

const routerFactoryAbi = [
    {
        type: "function",
        name: "factory",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }]
    }
] as const

const factoryPairAbi = [
    {
        type: "function",
        name: "getPair",
        stateMutability: "view",
        inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" }
        ],
        outputs: [{ type: "address" }]
    }
] as const

const pairReserveAbi = [
    {
        type: "function",
        name: "token0",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }]
    },
    {
        type: "function",
        name: "getReserves",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { name: "reserve0", type: "uint112" },
            { name: "reserve1", type: "uint112" },
            { name: "blockTimestampLast", type: "uint32" }
        ]
    }
] as const

const hookReadAbi = [
    {
        type: "function",
        name: "approvedRouter",
        inputs: [],
        outputs: [{ type: "address" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "entryPoint",
        inputs: [],
        outputs: [{ type: "address" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "deploymentChainId",
        inputs: [],
        outputs: [{ type: "uint256" }],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "wrappedNativeToken",
        inputs: [],
        outputs: [{ type: "address" }],
        stateMutability: "view"
    }
] as const

export type AgentChain = typeof bsc | typeof bscTestnet

export type AgentSmartAccountConfig = {
    chain: AgentChain
    rpcUrl: string
    bundlerRpcUrl: string
    routerAddress: Address
    policyHookAddress: Address
    targetTokenAddress: Address
    wrappedNativeAddress: Address
}

export function getAgentSmartAccountConfig(): AgentSmartAccountConfig {
    const chainId = process.env.NEXT_PUBLIC_CHAIN_ID
    const chain = getAgentChain(chainId)
    const rpcUrl =
        chain.id === bsc.id
            ? process.env.BSC_RPC_URL ?? process.env.NEXT_PUBLIC_BSC_RPC_URL
            : process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL
    if (!rpcUrl) {
        throw new Error(
            `Missing RPC URL for BSC chain ${chain.id}`
        )
    }
    const resolvedRpcUrl = chain.id === bsc.id && process.env.BSC_RPC_URL
        ? requireServerRpcUrl(process.env.BSC_RPC_URL)
        : resolvePublicRpcUrl(
            rpcUrl,
            rpcUrl,
            chain.id === bsc.id ? "NEXT_PUBLIC_BSC_RPC_URL" : "NEXT_PUBLIC_BSC_TESTNET_RPC_URL",
        )
    const bundlerRpcUrl =
        chain.id === bsc.id
            ? process.env.NEXT_PUBLIC_BSC_BUNDLER_RPC_URL
            : process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL

    return {
        chain,
        rpcUrl: resolvedRpcUrl,
        bundlerRpcUrl: requirePublicUrl(
            bundlerRpcUrl,
            chain.id === bsc.id
                ? "NEXT_PUBLIC_BSC_BUNDLER_RPC_URL"
                : "NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL"
        ),
        routerAddress: requireAddress(
            process.env.NEXT_PUBLIC_ROUTER_ADDRESS,
            "NEXT_PUBLIC_ROUTER_ADDRESS"
        ),
        policyHookAddress: requireAddress(
            process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS,
            "NEXT_PUBLIC_POLICY_HOOK_ADDRESS"
        ),
        targetTokenAddress: requireAddress(
            process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS,
            "NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS"
        ),
        wrappedNativeAddress: chain.id === bsc.id ? MAINNET_WBNB : TESTNET_WBNB
    }
}

export function createAgentPublicClient(config = getAgentSmartAccountConfig()) {
    return createPublicClient({
        chain: config.chain,
        transport: http(config.rpcUrl)
    })
}

export function createAgentSessionSigner() {
    return privateKeyToAccount(generatePrivateKey())
}

export type PoolReserves = {
    reserveIn: bigint
    reserveOut: bigint
}

export type DynamicQuote = {
    expectedAmountOut: bigint
    amountOutMin: bigint
    priceImpactBps: number
    slippageBps: number
    poolAddress: Address
}

export function calculateDynamicQuote(
    amountIn: bigint,
    reserves: PoolReserves,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    maxPriceImpactBps = DEFAULT_MAX_PRICE_IMPACT_BPS
) {
    if (amountIn <= BigInt(0)) throw new Error("amountIn must be greater than zero")
    if (reserves.reserveIn <= BigInt(0) || reserves.reserveOut <= BigInt(0)) {
        throw new Error("Pool reserves must both be greater than zero")
    }
    validateBasisPoints(slippageBps, MAX_SLIPPAGE_BPS, "slippageBps")
    validateBasisPoints(maxPriceImpactBps, MAX_PRICE_IMPACT_BPS, "maxPriceImpactBps")

    const amountInWithFee = amountIn * FEE_NUMERATOR
    const expectedAmountOut =
        amountInWithFee * reserves.reserveOut
        / (reserves.reserveIn * FEE_DENOMINATOR + amountInWithFee)
    if (expectedAmountOut <= BigInt(0)) {
        throw new Error("Pool quote rounds to zero output")
    }

    const spotAmountOut = amountIn * reserves.reserveOut / reserves.reserveIn
    if (spotAmountOut <= BigInt(0)) {
        throw new Error("Spot quote rounds to zero output")
    }
    const priceImpactBps = Number(
        (spotAmountOut - expectedAmountOut) * BPS / spotAmountOut
    )
    if (priceImpactBps > maxPriceImpactBps) {
        throw new Error(
            `Price impact ${priceImpactBps} bps exceeds maximum ${maxPriceImpactBps} bps`
        )
    }

    const amountOutMin =
        expectedAmountOut * BigInt(10_000 - slippageBps) / BPS
    if (amountOutMin <= BigInt(0)) {
        throw new Error("Calculated minimum output must be greater than zero")
    }
    return { expectedAmountOut, amountOutMin, priceImpactBps, slippageBps }
}

export async function buildAgentBuyCall(
    publicClient: Client,
    request: {
        accountAddress: Address
        amountBnb: bigint
        slippageBps?: number
        maxPriceImpactBps?: number
        deadline?: number
    },
    config = getAgentSmartAccountConfig()
) {
    if (request.amountBnb <= BigInt(0) || request.amountBnb > MAX_TRADE_VALUE) {
        throw new Error("amountBnb must be greater than zero and at most 0.5 BNB")
    }

    const factory = await readContract(publicClient, {
        address: config.routerAddress,
        abi: routerFactoryAbi,
        functionName: "factory"
    })
    const poolAddress = await readContract(publicClient, {
        address: factory,
        abi: factoryPairAbi,
        functionName: "getPair",
        args: [config.wrappedNativeAddress, config.targetTokenAddress]
    })
    if (poolAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("No PancakeSwap V2 pool exists for the configured route")
    }

    const [token0, reserves] = await Promise.all([
        readContract(publicClient, {
            address: poolAddress,
            abi: pairReserveAbi,
            functionName: "token0"
        }),
        readContract(publicClient, {
            address: poolAddress,
            abi: pairReserveAbi,
            functionName: "getReserves"
        })
    ])
    const [reserve0, reserve1] = reserves
    const token0IsWrapped = token0.toLowerCase() === config.wrappedNativeAddress.toLowerCase()
    const token0IsTarget = token0.toLowerCase() === config.targetTokenAddress.toLowerCase()
    if (!token0IsWrapped && !token0IsTarget) {
        throw new Error("Pool token ordering does not match the configured WBNB/token route")
    }
    const isWrappedNativeToken0 =
        token0IsWrapped
    const quote = calculateDynamicQuote(
        request.amountBnb,
        isWrappedNativeToken0
            ? { reserveIn: reserve0, reserveOut: reserve1 }
            : { reserveIn: reserve1, reserveOut: reserve0 },
        request.slippageBps,
        request.maxPriceImpactBps
    )

    return {
        ...encodeAgentBuyCall(
            request,
            quote.amountOutMin,
            config
        ),
        quote: { ...quote, poolAddress: getAddress(poolAddress) }
    }
}

export function encodeAgentBuyCall(
    request: {
        accountAddress: Address
        amountBnb: bigint
        deadline?: number
    },
    amountOutMin: bigint,
    config = getAgentSmartAccountConfig()
) {
    if (request.amountBnb <= BigInt(0) || request.amountBnb > MAX_TRADE_VALUE) {
        throw new Error("amountBnb must be greater than zero and at most 0.5 BNB")
    }
    if (amountOutMin <= BigInt(0)) {
        throw new Error("amountOutMin must be greater than zero")
    }
    const now = Math.floor(Date.now() / 1000)
    const deadline = request.deadline ?? now + SWAP_DEADLINE_SECONDS
    if (
        !Number.isSafeInteger(deadline)
        || deadline <= now
        || deadline > now + SWAP_DEADLINE_SECONDS
    ) {
        throw new Error("deadline must be within the next five minutes")
    }

    return {
        to: config.routerAddress,
        value: request.amountBnb,
        data: encodeFunctionData({
            abi: routerBuyAbi,
            functionName: "swapExactETHForTokens",
            args: [
                amountOutMin,
                [config.wrappedNativeAddress, config.targetTokenAddress],
                getAddress(request.accountAddress),
                BigInt(deadline)
            ]
        })
    }
}

export async function buildAgentKernelPluginManager(
    publicClient: Client,
    ownerValidator: KernelValidator,
    sessionKeySigner: Signer,
    config = getAgentSmartAccountConfig()
): Promise<KernelPluginManager<"0.7">> {
    const actualChainId = await getChainId(publicClient)
    if (actualChainId !== config.chain.id) {
        throw new Error(
            `RPC chain mismatch: expected ${config.chain.id}, received ${actualChainId}`
        )
    }

    const hookBytecode = await getBytecode(publicClient, {
        address: config.policyHookAddress
    })
    if (!hookBytecode || hookBytecode === "0x") {
        throw new Error(
            `No custom policy hook deployed at ${config.policyHookAddress}`
        )
    }

    const [
        approvedRouter,
        entryPoint,
        deploymentChainId,
        wrappedNativeToken,
        targetTokenCode
    ] = await Promise.all([
        readContract(publicClient, {
            address: config.policyHookAddress,
            abi: hookReadAbi,
            functionName: "approvedRouter"
        }),
        readContract(publicClient, {
            address: config.policyHookAddress,
            abi: hookReadAbi,
            functionName: "entryPoint"
        }),
        readContract(publicClient, {
            address: config.policyHookAddress,
            abi: hookReadAbi,
            functionName: "deploymentChainId"
        }),
        readContract(publicClient, {
            address: config.policyHookAddress,
            abi: hookReadAbi,
            functionName: "wrappedNativeToken"
        }),
        getBytecode(publicClient, {
            address: config.targetTokenAddress
        })
    ])

    if (approvedRouter.toLowerCase() !== config.routerAddress.toLowerCase()) {
        throw new Error(
            `Configured router ${config.routerAddress} does not match hook router ${approvedRouter}`
        )
    }
    if (entryPoint.toLowerCase() !== ENTRY_POINT.address.toLowerCase()) {
        throw new Error(
            `Hook EntryPoint ${entryPoint} does not match ZeroDev EntryPoint ${ENTRY_POINT.address}`
        )
    }
    if (deploymentChainId !== BigInt(config.chain.id)) {
        throw new Error(
            `Hook was deployed for chain ${deploymentChainId}, not ${config.chain.id}`
        )
    }
    if (wrappedNativeToken.toLowerCase() !== config.wrappedNativeAddress.toLowerCase()) {
        throw new Error(
            `Hook wrapped-native token ${wrappedNativeToken} does not match configured route ${config.wrappedNativeAddress}`
        )
    }
    if (!targetTokenCode || targetTokenCode === "0x") {
        throw new Error(
            `No target token contract deployed at ${config.targetTokenAddress}`
        )
    }

    const signer = await toECDSASigner({ signer: sessionKeySigner })
    const sessionValidator = await toPermissionValidator(publicClient, {
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1,
        signer,
        policies: [
            toCallPolicy({
                policyVersion: CallPolicyVersion.V0_0_5,
                permissions: [
                    {
                        callType: CallType.CALL,
                        target: config.routerAddress,
                        selector: BUY_SELECTOR,
                        valueLimit: MAX_TRADE_VALUE
                    }
                ]
            })
        ]
    })

    const executionHook: KernelValidatorHook = {
        getIdentifier: () => config.policyHookAddress,
        getEnableData: async () => concatHex([
            "0x00",
            encodeAbiParameters([{ type: "address" }], [config.targetTokenAddress])
        ])
    }

    return toKernelPluginManager(publicClient, {
        sudo: ownerValidator,
        regular: sessionValidator,
        hook: executionHook,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1,
        validUntil: Math.floor(Date.now() / 1000) + SESSION_VALIDITY_SECONDS
    })
}

export async function createAgentSmartAccountClient(
    ownerValidator: KernelValidator,
    sessionKeySigner: Signer,
    config = getAgentSmartAccountConfig()
) {
    const publicClient = createAgentPublicClient(config)
    const plugins = await buildAgentKernelPluginManager(
        publicClient,
        ownerValidator,
        sessionKeySigner,
        config
    )
    const account = await createKernelAccount(publicClient, {
        plugins,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1
    })
    const client = createKernelAccountClient({
        account,
        chain: config.chain,
        client: publicClient,
        bundlerTransport: http(config.bundlerRpcUrl)
    })

    return { account, client }
}

export type AgentTelemetryRecord = {
    event: "attempted" | "submitted" | "succeeded" | "rejected"
    reasonCode?: string
    account: Address
    targetToken: Address
    amountBnb: string
    timestamp: string
    userOperationHash?: Hex
    transactionHash?: Hex
    priceImpactBps?: number
    slippageBps?: number
    error?: string
}

export type AgentExecutionResult = {
    userOperationHash: Hex
    receipt: {
        success: boolean
        reason?: string
        receipt: { transactionHash: Hex }
    }
    quote?: Pick<DynamicQuote, "priceImpactBps" | "slippageBps">
}

export async function runAgentExecutionWithTelemetry(
    metadata: {
        account: Address
        targetToken: Address
        amountBnb: bigint
    },
    run: (onSubmitted: (hash: Hex, quote?: AgentExecutionResult["quote"]) => void) =>
        Promise<AgentExecutionResult>,
    log: (record: AgentTelemetryRecord) => void = record => {
        const method = record.event === "rejected" ? console.error : console.info
        method(JSON.stringify(record))
    }
) {
    const common = {
        account: metadata.account,
        targetToken: metadata.targetToken,
        amountBnb: metadata.amountBnb.toString(),
        timestamp: new Date().toISOString()
    }
    let submitted: { hash: Hex; quote?: AgentExecutionResult["quote"] } | undefined
    log({ event: "attempted", ...common })

    try {
        const result = await run((hash, quote) => {
            submitted = { hash, quote }
            log({
                event: "submitted",
                ...common,
                userOperationHash: hash,
                priceImpactBps: quote?.priceImpactBps,
                slippageBps: quote?.slippageBps
            })
        })
        if (!result.receipt.success) {
            throw new Error(result.receipt.reason || "UserOperation execution reverted")
        }
        log({
            event: "succeeded",
            ...common,
            userOperationHash: result.userOperationHash,
            transactionHash: result.receipt.receipt.transactionHash,
            priceImpactBps: result.quote?.priceImpactBps,
            slippageBps: result.quote?.slippageBps
        })
        return result
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown execution error"
        log({
            event: "rejected",
            reasonCode: classifyAgentError(message),
            ...common,
            userOperationHash: submitted?.hash,
            priceImpactBps: submitted?.quote?.priceImpactBps,
            slippageBps: submitted?.quote?.slippageBps,
            error: message
        })
        throw error
    }
}

export async function executeAgentBuy(
    accountClient: Awaited<ReturnType<typeof createAgentSmartAccountClient>>["client"],
    request: {
        amountBnb: bigint
        slippageBps?: number
        maxPriceImpactBps?: number
        deadline?: number
    },
    config = getAgentSmartAccountConfig(),
    log: (record: AgentTelemetryRecord) => void = record => {
        const method = record.event === "rejected" ? console.error : console.info
        method(JSON.stringify(record))
    }
) {
    const account = accountClient.account
    return runAgentExecutionWithTelemetry(
        {
            account: account.address,
            targetToken: config.targetTokenAddress,
            amountBnb: request.amountBnb
        },
        async onSubmitted => {
        const call = await buildAgentBuyCall(
            accountClient.client,
            { ...request, accountAddress: account.address },
            config
        )
        const userOperationHash = await accountClient.sendUserOperation({
            calls: [{
                to: call.to,
                value: call.value,
                data: call.data
            }]
        })
        onSubmitted(userOperationHash, call.quote)
        const result = await accountClient.waitForUserOperationReceipt({
            hash: userOperationHash
        })
        return {
            userOperationHash,
            receipt: result,
            quote: call.quote
        }
        },
        log
    )
}

function classifyAgentError(message: string) {
    if (message.includes("Price impact")) return "PRICE_IMPACT_EXCEEDED"
    if (message.includes("slippageBps")) return "SLIPPAGE_CONFIGURATION_INVALID"
    if (message.includes("pool") || message.includes("Pool")) return "POOL_UNAVAILABLE"
    if (message.includes("reverted")) return "USER_OPERATION_REVERTED"
    return "EXECUTION_FAILED"
}

function validateBasisPoints(value: number, maximum: number, name: string) {
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${name} must be an integer between 1 and ${maximum}`)
    }
}

function getAgentChain(chainId: string | undefined): AgentChain {
    if (chainId === String(bsc.id)) return bsc
    if (chainId === String(bscTestnet.id)) return bscTestnet
    throw new Error(
        "NEXT_PUBLIC_CHAIN_ID must be 56 (BSC) or 97 (BSC testnet)"
    )
}

function requireAddress(
    value: string | undefined,
    variableName: string
): Address {
    if (!value || !isAddress(value)) {
        throw new Error(`${variableName} must be a valid EVM address`)
    }
    return getAddress(value)
}

function requirePublicUrl(value: string | undefined, variableName: string) {
    if (!value) {
        throw new Error(`${variableName} must be a public bundler RPC URL`)
    }

    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`${variableName} must be a valid public HTTP(S) URL`)
    }
    if (
        (url.protocol !== "https:" && url.protocol !== "http:")
        || url.username
        || url.password
        || url.hash
        || url.search
    ) {
        throw new Error(
            `${variableName} must be a public HTTP(S) URL without credentials or query parameters`
        )
    }
    return url.toString()
}

function requireServerRpcUrl(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error("BSC_RPC_URL must be a valid server-side HTTP(S) RPC URL.")
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash) {
        throw new Error("BSC_RPC_URL must be a server-side HTTP(S) RPC URL.")
    }
    return url.toString()
}
