import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isValidBinanceQuoteId } from "../lib/apiValidation.ts"
import { verifyBrowserTradeBinding } from "../lib/browserTradeBinding.ts"
import {
    BrowserTradeIntentStoreError,
    hashQuoteBinding,
    type BrowserTradeIntentStorePort,
} from "./browserTradeIntentStore.ts"

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type BrowserTradeBoundaryResult =
    | { ok: true; code: "UNSUPPORTED_SWAP_SCHEMA" | "UNSUPPORTED_APPROVAL_SCHEMA" | "UNSUPPORTED_RFQ_SCHEMA" }
    | { ok: false; status: number; code: string; reason: string }

export async function rejectUnsupportedBrowserExecution(input: {
    executionId: string
    quoteId: string
    quoteBinding: string
    wallet: string
    toToken: string
    amount: string
    operation: "SWAP" | "APPROVAL" | "RFQ"
    now?: number
    store: BrowserTradeIntentStorePort
}): Promise<BrowserTradeBoundaryResult> {
    if (
        !UUID_V4_PATTERN.test(input.executionId) ||
        !isValidBinanceQuoteId(input.quoteId) ||
        typeof input.quoteBinding !== "string" ||
        input.quoteBinding.length > 2_048 ||
        !EVM_ADDRESS_PATTERN.test(input.wallet) ||
        !EVM_ADDRESS_PATTERN.test(input.toToken) ||
        !/^(?:0|[1-9]\d*)$/.test(input.amount)
    ) return { ok: false, status: 400, code: "INVALID_INTENT", reason: "Invalid trade intent parameters." }

    try {
        await input.store.initialize()
        const intent = await input.store.get(input.executionId)
        if (!intent) return { ok: false, status: 404, code: "INTENT_NOT_FOUND", reason: "Trade intent was not found." }
        if (
            intent.quoteId !== input.quoteId ||
            intent.inputAmount !== input.amount ||
            intent.outputTokenAddress.toLowerCase() !== input.toToken.toLowerCase() ||
            intent.inputTokenAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase() ||
            intent.walletAddress.toLowerCase() !== input.wallet.toLowerCase() ||
            hashQuoteBinding(input.quoteBinding) !== intent.quoteBindingHash
        ) return { ok: false, status: 409, code: "INTENT_MISMATCH", reason: "Trade binding does not match the stored intent." }

        const now = input.now ?? Date.now()
        if (intent.expiresAt <= now) {
            await input.store.prepare(intent.executionId, input.wallet, now)
        }
        const binding = verifyBrowserTradeBinding(input.quoteBinding, {
            executionId: intent.executionId,
            quoteId: intent.quoteId,
            wallet: intent.walletAddress,
            chainId: intent.chainId,
            direction: intent.direction,
            fromToken: intent.inputTokenAddress,
            toToken: intent.outputTokenAddress,
            amount: intent.inputAmount,
            slippageBps: intent.slippageBps,
        }, now)
        if (!binding.ok || binding.expiresAt !== intent.expiresAt) {
            return { ok: false, status: 409, code: "INVALID_BINDING", reason: binding.ok ? "Trade binding expiration does not match the stored intent." : binding.reason }
        }

        await input.store.prepare(intent.executionId, input.wallet, now)
        const code = input.operation === "SWAP"
            ? "UNSUPPORTED_SWAP_SCHEMA"
            : input.operation === "APPROVAL"
                ? "UNSUPPORTED_APPROVAL_SCHEMA"
                : "UNSUPPORTED_RFQ_SCHEMA"
        await input.store.reject(intent.executionId, code, now)
        return { ok: true, code }
    } catch (error) {
        if (error instanceof BrowserTradeIntentStoreError) {
            const status = error.code === "NOT_FOUND" ? 404 : error.code === "EXPIRED" ? 410 : error.code === "CONSUMED" ? 409 : 503
            return { ok: false, status, code: error.code, reason: storeReason(error.code) }
        }
        throw error
    }
}

function storeReason(code: BrowserTradeIntentStoreError["code"]): string {
    switch (code) {
        case "NOT_FOUND": return "Trade intent was not found."
        case "EXPIRED": return "Trade intent has expired."
        case "CONSUMED": return "Trade intent has already been consumed."
        default: return "Durable trade-intent storage is unavailable."
    }
}
