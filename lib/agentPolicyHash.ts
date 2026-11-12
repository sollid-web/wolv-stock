import {
    encodeAbiParameters,
    getAddress,
    keccak256,
    type Address,
    type Hex
} from "viem"

export type AgentPolicyHashInput = {
    strategyId: string
    account: Address
    targetToken: Address
    maxTradeValue: bigint
    expiresAt: bigint
    intentSigner: Address
    amountBnb: bigint
    entryPriceMicros: bigint
    slippageBps: number
    maxPriceImpactBps: number
}

const MAX_TRADE_VALUE = BigInt("500000000000000000")
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1)
const MAX_UINT192 = (BigInt(1) << BigInt(192)) - BigInt(1)

export function hashAgentPolicy(input: AgentPolicyHashInput): Hex {
    if (typeof input.strategyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.strategyId)) {
        throw new TypeError("Policy strategy ID must be 1-64 safe identifier characters.")
    }
    const account = getAddress(input.account)
    const targetToken = getAddress(input.targetToken)
    const intentSigner = getAddress(input.intentSigner)
    if (
        account === "0x0000000000000000000000000000000000000000"
        || targetToken === "0x0000000000000000000000000000000000000000"
        || intentSigner === "0x0000000000000000000000000000000000000000"
    ) {
        throw new TypeError("Policy token and intent signer must be nonzero addresses.")
    }
    if (input.maxTradeValue <= BigInt(0) || input.maxTradeValue > MAX_TRADE_VALUE || input.maxTradeValue > MAX_UINT192) {
        throw new RangeError("Policy maximum trade value must be between 1 wei and 0.5 BNB.")
    }
    if (input.expiresAt <= BigInt(0) || input.expiresAt > MAX_UINT64) {
        throw new RangeError("Policy expiry must fit uint64 and be greater than zero.")
    }
    if (input.amountBnb <= BigInt(0) || input.amountBnb > input.maxTradeValue) {
        throw new RangeError("Strategy amount must be positive and no greater than the on-chain trade cap.")
    }
    if (input.entryPriceMicros <= BigInt(0)) {
        throw new RangeError("Strategy entry-price threshold must be greater than zero.")
    }
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500) {
        throw new RangeError("Strategy slippage must be between 1 and 500 basis points.")
    }
    if (!Number.isInteger(input.maxPriceImpactBps) || input.maxPriceImpactBps < 1 || input.maxPriceImpactBps > 300) {
        throw new RangeError("Strategy maximum price impact must be between 1 and 300 basis points.")
    }

    return keccak256(encodeAbiParameters(
        [
            { type: "string" }, { type: "string" }, { type: "address" }, { type: "address" },
            { type: "uint192" }, { type: "uint64" }, { type: "address" },
            { type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "uint16" }
        ],
        [
            "WOLV_AGENT_POLICY_V3", input.strategyId, account, targetToken,
            input.maxTradeValue, input.expiresAt, intentSigner,
            input.amountBnb, input.entryPriceMicros, input.slippageBps, input.maxPriceImpactBps
        ]
    ))
}
