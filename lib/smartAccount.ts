import "server-only"
import { createKernelAccount } from "@zerodev/sdk/accounts"
import { createKernelAccountClient } from "@zerodev/sdk/clients"
import type { KernelValidator } from "@zerodev/sdk"
import type { Signer } from "@zerodev/sdk/types"
import {
    type Address,
    type Client,
    type Hex,
    createPublicClient,
    encodeFunctionData,
    getAddress,
    http,
    isAddress,
    parseEther
} from "viem"
import { estimateFeesPerGas, getBytecode, getChainId, readContract } from "viem/actions"
import { bsc, bscTestnet } from "viem/chains"
import {
    AGENT_ENTRY_POINT,
    AGENT_KERNEL_VERSION,
    createAgentPluginManager,
    readKernelEcdsaOwner
} from "./agentPermission.ts"
import { resolvePublicRpcUrl } from "./publicRpcUrl.ts"

const ENTRY_POINT = AGENT_ENTRY_POINT
const MAX_TRADE_VALUE = parseEther("0.5")
export const AGENT_SWAP_DEADLINE_SECONDS = 15
const SWAP_DEADLINE_SECONDS = AGENT_SWAP_DEADLINE_SECONDS
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

    const wrappedNativeAddress = chain.id === bsc.id ? MAINNET_WBNB : TESTNET_WBNB
    const targetTokenAddress = requireAddress(
        process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS,
        "NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS"
    )
    if (targetTokenAddress === wrappedNativeAddress) {
        throw new Error(
            "NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS must not be WBNB: the agent buys the target token with BNB through a WBNB/token pool."
        )
    }

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
        targetTokenAddress,
        wrappedNativeAddress
    }
}

export function createAgentPublicClient(config = getAgentSmartAccountConfig()) {
    return createPublicClient({
        chain: config.chain,
        transport: http(config.rpcUrl)
    })
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

    const reservesInOut = isWrappedNativeToken0
        ? { reserveIn: reserve0, reserveOut: reserve1 }
        : { reserveIn: reserve1, reserveOut: reserve0 }

    return {
        ...encodeAgentBuyCall(
            request,
            quote.amountOutMin,
            config
        ),
        reserves: reservesInOut,
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
        throw new Error("deadline must be within the next 15 seconds")
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
    config: AgentSmartAccountConfig,
    authorization: AgentAccountAuthorization
) {
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

    return createAgentPluginManager(publicClient, {
        ownerValidator,
        agentSigner: sessionKeySigner,
        targets: { ...config, permissionValidUntil: authorization.permissionValidUntil },
        pluginEnableSignature: authorization.pluginEnableSignature
    })
}

export type AgentAccountAuthorization = {
    /** The existing smart account. Never re-derived: an index/owner mismatch must not move funds. */
    accountAddress: Address
    /** On-chain owner the schedule was registered for. Re-checked before every client build. */
    ownerAddress: Address
    /** Owner's one-time Kernel enable signature; only needed until the agent validator is enabled. */
    pluginEnableSignature?: Hex
    /** On-chain policy expiry (Unix seconds); the agent validator's TimestampPolicy bound. */
    permissionValidUntil: bigint
}

export async function createAgentSmartAccountClient(
    ownerValidator: KernelValidator,
    sessionKeySigner: Signer,
    config: AgentSmartAccountConfig,
    authorization: AgentAccountAuthorization
) {
    const publicClient = createAgentPublicClient(config)
    const onChainOwner = await readKernelEcdsaOwner(publicClient, authorization.accountAddress)
    if (onChainOwner !== getAddress(authorization.ownerAddress)) {
        throw new Error(
            `Smart account ${authorization.accountAddress} is owned by ${onChainOwner}, not schedule owner ${authorization.ownerAddress}.`
        )
    }
    const plugins = await buildAgentKernelPluginManager(
        publicClient,
        ownerValidator,
        sessionKeySigner,
        config,
        authorization
    )
    const account = await createKernelAccount(publicClient, {
        plugins,
        entryPoint: ENTRY_POINT,
        kernelVersion: AGENT_KERNEL_VERSION,
        address: getAddress(authorization.accountAddress)
    })
    const client = createKernelAccountClient({
        account,
        chain: config.chain,
        client: publicClient,
        bundlerTransport: http(config.bundlerRpcUrl),
        // The SDK's default fee source is ZeroDev's `zd_getUserOperationGasPrice`, which
        // standard ERC-4337 bundlers (e.g. Pimlico) do not implement. Use chain EIP-1559 fees,
        // exactly as the owner's browser client does.
        userOperation: {
            estimateFeesPerGas: async () => estimateFeesPerGas(publicClient, { type: "eip1559" })
        }
    })

    return { account, client }
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
    ) {
        throw new Error(
            `${variableName} must be a public HTTP(S) URL without embedded credentials or fragments`
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
