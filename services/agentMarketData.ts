import type { PublicClient } from "viem"
import { readContract } from "viem/actions"
import { buildAgentBuyCall, type AgentSmartAccountConfig } from "../lib/smartAccount.ts"
import type { AgentStrategy, MarketSnapshot } from "./agentWorker.ts"

/**
 * Live market snapshot for an agent strategy: the guardian-allowlisted Chainlink USD price the
 * policy hook enforces, plus PancakeSwap pool reserves. Shared by the worker and the simulator.
 */
const policyFeedAbi = [
    {
        type: "function",
        name: "tokenUsdFeeds",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ type: "address" }]
    },
    {
        type: "function",
        name: "tokenFeedMaxAge",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ type: "uint32" }]
    }
] as const

const chainlinkFeedAbi = [
    {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }]
    },
    {
        type: "function",
        name: "latestRoundData",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { type: "uint80" },
            { type: "int256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint80" }
        ]
    }
] as const

export async function fetchMarketData(
    strategy: AgentStrategy,
    config: AgentSmartAccountConfig,
    client: PublicClient
): Promise<MarketSnapshot> {
    const snapshot = await fetchChainlinkMarketData(strategy, config, client)
    return { ...snapshot, receivedAt: Date.now() }
}

async function fetchChainlinkMarketData(
    strategy: AgentStrategy,
    config: AgentSmartAccountConfig,
    client: PublicClient
): Promise<MarketSnapshot> {
    const [feed, maxAge] = await Promise.all([
        readContract(client, {
            address: config.policyHookAddress,
            abi: policyFeedAbi,
            functionName: "tokenUsdFeeds",
            args: [strategy.targetToken]
        }),
        readContract(client, {
            address: config.policyHookAddress,
            abi: policyFeedAbi,
            functionName: "tokenFeedMaxAge",
            args: [strategy.targetToken]
        })
    ])
    if (feed === "0x0000000000000000000000000000000000000000" || maxAge < 60 || maxAge > 86_400) {
        throw new Error("Target token has no valid guardian-allowlisted Chainlink USD feed.")
    }
    const [decimals, round] = await Promise.all([
        readContract(client, {
            address: feed,
            abi: chainlinkFeedAbi,
            functionName: "decimals"
        }),
        readContract(client, {
            address: feed,
            abi: chainlinkFeedAbi,
            functionName: "latestRoundData"
        })
    ])
    const [roundId, answer, , updatedAt, answeredInRound] = round
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
    if (
        decimals > 18
        || roundId === BigInt(0)
        || answer <= BigInt(0)
        || updatedAt === BigInt(0)
        || updatedAt > nowSeconds
        || nowSeconds - updatedAt > BigInt(maxAge)
        || answeredInRound < roundId
    ) {
        throw new Error("Chainlink target-token USD feed is invalid, incomplete, future-dated, or stale.")
    }
    const normalizedPrice = answer * (BigInt(10) ** BigInt(18 - decimals))
    if (normalizedPrice <= BigInt(0) || normalizedPrice > BigInt(10) ** BigInt(36)) {
        throw new Error("Chainlink target-token USD price is outside supported bounds.")
    }
    const priceMicros = (normalizedPrice - BigInt(1)) / BigInt(1_000_000_000_000) + BigInt(1)
    const marketCall = await buildAgentBuyCall(client, {
        accountAddress: strategy.account,
        amountBnb: strategy.amountBnb,
        slippageBps: strategy.slippageBps,
        maxPriceImpactBps: strategy.maxPriceImpactBps
    }, config)
    const observedAt = Date.now()
    return {
        priceMicros,
        reserves: marketCall.reserves,
        observedAt,
        receivedAt: observedAt
    }
}
