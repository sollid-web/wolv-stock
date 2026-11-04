import {
    encodePacked,
    getAddress,
    keccak256,
    type Address,
    type Hex
} from "viem"

export type AgentPolicyHashInput = {
    targetToken: Address
    maxTradeValue: bigint
    expiresAt: bigint
    intentSigner: Address
}

const MAX_TRADE_VALUE = BigInt("500000000000000000")
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1)
const MAX_UINT192 = (BigInt(1) << BigInt(192)) - BigInt(1)

export function hashAgentPolicy(input: AgentPolicyHashInput): Hex {
    const targetToken = getAddress(input.targetToken)
    const intentSigner = getAddress(input.intentSigner)
    if (
        targetToken === "0x0000000000000000000000000000000000000000"
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

    return keccak256(encodePacked(
        ["address", "uint192", "uint64", "address"],
        [targetToken, input.maxTradeValue, input.expiresAt, intentSigner]
    ))
}
