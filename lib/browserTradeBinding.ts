import crypto from "node:crypto"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isPositiveUint256 } from "./apiValidation.ts"
import { TRADE_QUOTE_TTL_MS } from "./tradeReadiness.ts"

export type BrowserTradeBindingInput = {
    executionId: string
    quoteId: string
    wallet: string
    chainId: 56
    direction: "BUY"
    fromToken: string
    toToken: string
    amount: string
    slippageBps: number
}

type BrowserTradeBindingPayload = BrowserTradeBindingInput & {
    issuedAt: number
    expiresAt: number
}

function bindingSecret(): string {
    const secret = process.env.BINANCE_SECRET_KEY
    if (!secret) throw new Error("Quote binding secret is not configured")
    return secret
}

export function assertBrowserTradeBindingAvailable(): void {
    bindingSecret()
}

function sign(payload: string): string {
    return crypto.createHmac("sha256", bindingSecret()).update(payload, "utf8").digest("base64url")
}

export function createBrowserTradeBinding(input: BrowserTradeBindingInput, issuedAt = Date.now()): string {
    validateInput(input)
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("Invalid quote timestamp")
    const payload = Buffer.from(JSON.stringify({
        ...input,
        issuedAt,
        expiresAt: issuedAt + TRADE_QUOTE_TTL_MS,
    }), "utf8").toString("base64url")
    return `${payload}.${sign(payload)}`
}

export function verifyBrowserTradeBinding(
    binding: string,
    expected: BrowserTradeBindingInput,
    now = Date.now(),
): { ok: true; issuedAt: number; expiresAt: number } | { ok: false; reason: string } {
    try {
        validateInput(expected)
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(binding)) {
            return { ok: false, reason: "Malformed trade binding" }
        }
        const [encodedPayload, providedSignature] = binding.split(".")
        const expectedSignature = sign(encodedPayload)
        const provided = Buffer.from(providedSignature, "base64url")
        const expectedBytes = Buffer.from(expectedSignature, "base64url")
        if (provided.length !== expectedBytes.length || !crypto.timingSafeEqual(provided, expectedBytes)) {
            return { ok: false, reason: "Trade binding signature mismatch" }
        }
        const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<BrowserTradeBindingPayload>
        if (
            payload.executionId !== expected.executionId ||
            payload.quoteId !== expected.quoteId ||
            payload.wallet?.toLowerCase() !== expected.wallet.toLowerCase() ||
            payload.chainId !== expected.chainId ||
            payload.direction !== expected.direction ||
            payload.fromToken?.toLowerCase() !== expected.fromToken.toLowerCase() ||
            payload.toToken?.toLowerCase() !== expected.toToken.toLowerCase() ||
            payload.amount !== expected.amount ||
            payload.slippageBps !== expected.slippageBps
        ) return { ok: false, reason: "Trade binding does not match the approved intent" }
        const issuedAt = Number(payload.issuedAt)
        const expiresAt = Number(payload.expiresAt)
        if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
            return { ok: false, reason: "Trade binding has invalid timestamps" }
        }
        if (
            expiresAt !== issuedAt + TRADE_QUOTE_TTL_MS ||
            now < issuedAt ||
            now >= expiresAt
        ) return { ok: false, reason: "Trade binding expired" }
        return { ok: true, issuedAt, expiresAt }
    } catch {
        return { ok: false, reason: "Invalid trade binding" }
    }
}

function validateInput(input: BrowserTradeBindingInput): void {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.executionId) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.quoteId) ||
        !EVM_ADDRESS_PATTERN.test(input.wallet) ||
        input.chainId !== 56 ||
        input.direction !== "BUY" ||
        input.fromToken.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase() ||
        !EVM_ADDRESS_PATTERN.test(input.fromToken) ||
        !EVM_ADDRESS_PATTERN.test(input.toToken) ||
        input.fromToken.toLowerCase() === input.toToken.toLowerCase() ||
        !isPositiveUint256(input.amount) ||
        !Number.isSafeInteger(input.slippageBps) ||
        input.slippageBps < 1 ||
        input.slippageBps > 500
    ) throw new Error("Invalid browser trade binding parameters")
}
