const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const UINT256_PATTERN = /^0x[a-fA-F0-9]{64}$/

export type SwapOutcome =
    | { state: "REVERTED"; receivedAmount: "0"; reason: string }
    | { state: "OUTPUT_VERIFIED"; receivedAmount: string; reason: null }
    | { state: "OUTPUT_MISMATCH"; receivedAmount: string; reason: string }
    | { state: "UNKNOWN"; receivedAmount: null; reason: string }

export function verifySwapReceiptOutput(input: {
    receipt: unknown
    tokenAddress: string
    recipientAddress: string
    minimumOutputAmount: string
}): SwapOutcome {
    if (
        !ADDRESS_PATTERN.test(input.tokenAddress) ||
        !ADDRESS_PATTERN.test(input.recipientAddress) ||
        !/^(?:0|[1-9]\d*)$/.test(input.minimumOutputAmount) ||
        BigInt(input.minimumOutputAmount) <= BigInt(0)
    ) return { state: "UNKNOWN", receivedAmount: null, reason: "Trade output verification parameters are invalid." }
    if (!isRecord(input.receipt) || !Array.isArray(input.receipt.logs)) {
        return { state: "UNKNOWN", receivedAmount: null, reason: "Transaction receipt or logs are unavailable." }
    }
    if (input.receipt.status === "reverted") {
        return { state: "REVERTED", receivedAmount: "0", reason: "Transaction receipt reports a revert." }
    }
    if (input.receipt.status !== "success") {
        return { state: "UNKNOWN", receivedAmount: null, reason: "Transaction receipt status is not confirmed." }
    }

    let received = BigInt(0)
    for (const value of input.receipt.logs) {
        if (!isRecord(value) || typeof value.address !== "string" || !Array.isArray(value.topics)) continue
        if (value.address.toLowerCase() !== input.tokenAddress.toLowerCase()) continue
        const [topic, fromTopic, toTopic] = value.topics
        if (typeof topic !== "string" || topic.toLowerCase() !== TRANSFER_TOPIC) continue
        if (
            typeof fromTopic !== "string" || !UINT256_PATTERN.test(fromTopic) ||
            typeof toTopic !== "string" || !UINT256_PATTERN.test(toTopic) ||
            typeof value.data !== "string" || !UINT256_PATTERN.test(value.data)
        ) return { state: "UNKNOWN", receivedAmount: null, reason: "A matching token Transfer event is malformed." }
        const recipient = `0x${toTopic.slice(-40)}`
        if (recipient.toLowerCase() === input.recipientAddress.toLowerCase()) {
            received += BigInt(value.data)
        }
    }

    const receivedAmount = received.toString()
    if (received < BigInt(input.minimumOutputAmount)) {
        return {
            state: "OUTPUT_MISMATCH",
            receivedAmount,
            reason: received === BigInt(0)
                ? "No expected-token transfer to the connected wallet was found."
                : "Verified output is below the approved minimum.",
        }
    }
    return { state: "OUTPUT_VERIFIED", receivedAmount, reason: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
