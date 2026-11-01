import { decodeFunctionData } from "viem"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isPositiveUint256 } from "./apiValidation.ts"

const erc20ApproveAbi = [{
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
}] as const

export type ApprovalValidationInput = {
    tokenAddress: string
    calldata: string
    spender: string
    quoteBoundSpender: string
    trustedSpenders: readonly string[]
    expectedAmount: string
    currentAllowance: string
    resetOnly?: boolean
}

export type ApprovalValidationResult =
    | { ok: true; spender: string; amount: string; kind: "EXACT" | "ZERO_RESET" }
    | { ok: false; reason: string }

export function validateApprovalTransaction(input: ApprovalValidationInput): ApprovalValidationResult {
    if (input.tokenAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase()) {
        return { ok: false, reason: "Approval token is not the supported BSC USDT contract." }
    }
    if (
        !EVM_ADDRESS_PATTERN.test(input.spender) ||
        !EVM_ADDRESS_PATTERN.test(input.quoteBoundSpender) ||
        input.spender.toLowerCase() !== input.quoteBoundSpender.toLowerCase()
    ) return { ok: false, reason: "Approval spender does not match the quote-bound spender." }
    if (!input.trustedSpenders.some((address) =>
        EVM_ADDRESS_PATTERN.test(address) && address.toLowerCase() === input.spender.toLowerCase()
    )) return { ok: false, reason: "Approval spender is not in the reviewed trusted spender list." }
    if (!isPositiveUint256(input.expectedAmount) || !/^(?:0|[1-9]\d*)$/.test(input.currentAllowance)) {
        return { ok: false, reason: "Approval amount or current allowance is invalid." }
    }
    if (!/^0x095ea7b3[0-9a-fA-F]{128}$/.test(input.calldata)) {
        return { ok: false, reason: "Unsupported approval selector or calldata format." }
    }

    let decoded: ReturnType<typeof decodeFunctionData<typeof erc20ApproveAbi>>
    try {
        decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: input.calldata as `0x${string}` })
    } catch {
        return { ok: false, reason: "Approval calldata could not be decoded." }
    }
    if (decoded.functionName !== "approve") return { ok: false, reason: "Unsupported approval function." }
    const [decodedSpender, decodedAmount] = decoded.args
    if (decodedSpender.toLowerCase() !== input.spender.toLowerCase()) {
        return { ok: false, reason: "Approval calldata spender does not match the approved spender." }
    }
    if (decodedAmount === BigInt(0)) {
        if (!input.resetOnly || BigInt(input.currentAllowance) === BigInt(0)) {
            return { ok: false, reason: "Zero-reset approval is not required for this allowance." }
        }
        return { ok: true, spender: decodedSpender, amount: "0", kind: "ZERO_RESET" }
    }
    if (input.resetOnly || decodedAmount !== BigInt(input.expectedAmount)) {
        return { ok: false, reason: "Approval amount must equal the exact requested trade amount." }
    }
    return { ok: true, spender: decodedSpender, amount: decodedAmount.toString(), kind: "EXACT" }
}

export type ProviderExecutionRejection = {
    ok: false
    code: "UNSUPPORTED_SWAP_SCHEMA" | "UNSUPPORTED_RFQ_SCHEMA"
    reason: string
}

export function validateBinanceSwapResponse(_response: unknown): ProviderExecutionRejection {
    return {
        ok: false,
        code: "UNSUPPORTED_SWAP_SCHEMA",
        reason: "Binance SWAP transaction schema is not documented or fixture-verified; execution is disabled.",
    }
}

export function validateBinanceRfqTypedData(_typedData: unknown): ProviderExecutionRejection {
    return {
        ok: false,
        code: "UNSUPPORTED_RFQ_SCHEMA",
        reason: "Binance RFQ typed-data schema is not documented or fixture-verified; signing and submission are disabled.",
    }
}
