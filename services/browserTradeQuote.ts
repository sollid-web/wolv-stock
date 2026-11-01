import { randomUUID } from "node:crypto"
import {
    BSC_USDT_ADDRESS,
    EVM_ADDRESS_PATTERN,
    MINIMUM_ORDER_USDT,
    MINIMUM_ORDER_WEI,
    isValidBinanceQuoteId,
    isPositiveUint256,
    normalizeUint256,
} from "../lib/apiValidation.ts"
import { assertBrowserTradeBindingAvailable, createBrowserTradeBinding } from "../lib/browserTradeBinding.ts"
import { TRADE_QUOTE_TTL_MS } from "../lib/tradeReadiness.ts"
import { validateQuote } from "../lib/quoteValidation.ts"
import {
    hashQuoteBinding,
    type BrowserTradeIntent,
    type BrowserTradeIntentStorePort,
} from "./browserTradeIntentStore.ts"

const SLIPPAGE_BPS = 50
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD"

export type BrowserTradeQuoteDependencies = {
    getQuote: (toToken: string, amount: string, wallet: string) => Promise<unknown>
    getAssetList: () => Promise<unknown>
    isSpotToken: (address: string) => Promise<boolean>
    store: BrowserTradeIntentStorePort | (() => BrowserTradeIntentStorePort)
    now?: () => number
    createExecutionId?: () => string
}

export class BrowserTradeQuoteError extends Error {
    code: "INVALID_INPUT" | "UNSUPPORTED_TOKEN" | "QUOTE_REJECTED" | "STORE_UNAVAILABLE"
    status: number

    constructor(
        code: "INVALID_INPUT" | "UNSUPPORTED_TOKEN" | "QUOTE_REJECTED" | "STORE_UNAVAILABLE",
        message: string,
        status: number,
    ) {
        super(message)
        this.name = "BrowserTradeQuoteError"
        this.code = code
        this.status = status
    }
}

export async function createBrowserTradeQuote(
    input: { toToken: string; amount: string; wallet: string },
    dependencies: BrowserTradeQuoteDependencies,
) {
    const now = dependencies.now ?? Date.now
    const executionId = (dependencies.createExecutionId ?? randomUUID)()

    if (
        !EVM_ADDRESS_PATTERN.test(input.toToken) ||
        !EVM_ADDRESS_PATTERN.test(input.wallet) ||
        !isPositiveUint256(input.amount) ||
        input.wallet.toLowerCase() === DEAD_ADDRESS.toLowerCase()
    ) throw new BrowserTradeQuoteError("INVALID_INPUT", "Invalid token, wallet, or amount", 400)

    const amount = normalizeUint256(input.amount)
    if (!amount || BigInt(amount) < MINIMUM_ORDER_WEI) {
        throw new BrowserTradeQuoteError("INVALID_INPUT", `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).`, 400)
    }
    const store = typeof dependencies.store === "function" ? dependencies.store() : dependencies.store
    if (!await dependencies.isSpotToken(input.toToken)) {
        throw new BrowserTradeQuoteError("UNSUPPORTED_TOKEN", "Only supported spot tokenized assets can be quoted", 400)
    }

    try {
        await store.initialize()
    } catch (error) {
        throw new BrowserTradeQuoteError(
            "STORE_UNAVAILABLE",
            "Durable trade-intent storage is unavailable; quote retrieval is disabled.",
            503,
        )
    }
    try {
        assertBrowserTradeBindingAvailable()
    } catch {
        throw new BrowserTradeQuoteError(
            "STORE_UNAVAILABLE",
            "Quote integrity signing is not configured; quote retrieval is disabled.",
            503,
        )
    }

    const result = await dependencies.getQuote(input.toToken, amount, input.wallet)
    const response = isRecord(result) ? result : null
    const quote = response && Array.isArray(response.data) && isRecord(response.data[0])
        ? response.data[0]
        : null
    if (!quote) throw new BrowserTradeQuoteError("QUOTE_REJECTED", "No quote returned from aggregator", 502)

    const rawQuoteId = isValidBinanceQuoteId(quote.quoteId) ? quote.quoteId : null
    if (!rawQuoteId) {
        throw new BrowserTradeQuoteError("QUOTE_REJECTED", "Quote response is missing a valid quote ID", 502)
    }
    const providerFromToken = isRecord(quote.fromToken) ? quote.fromToken : null
    const providerToToken = isRecord(quote.toToken) ? quote.toToken : null
    const fromTokenAmount = providerIntegerAmount(quote.fromTokenAmount)
    const toTokenAmount = providerIntegerAmount(quote.toTokenAmount)
    const outputAmount = toTokenAmount ? normalizeUint256(toTokenAmount) : null
    if (
        quote.binanceChainId !== "56" ||
        quote.executionMode !== "RFQ" ||
        !matchesTokenAddress(providerFromToken?.tokenContractAddress, BSC_USDT_ADDRESS) ||
        !matchesTokenAddress(providerToToken?.tokenContractAddress, input.toToken) ||
        typeof providerFromToken?.decimal !== "string" ||
        typeof providerToToken?.decimal !== "string" ||
        !fromTokenAmount ||
        !outputAmount ||
        BigInt(outputAmount) <= BigInt(0)
    ) {
        throw new BrowserTradeQuoteError("QUOTE_REJECTED", "Quote response does not match the documented BSC RWA quote contract", 502)
    }

    const quoteValidation = validateQuote({
        fromTokenAmount,
        toTokenAmount,
        fromTokenDecimals: providerFromToken.decimal,
        toTokenDecimals: providerToToken.decimal,
        tokenUnitPrice: providerFromToken.tokenUnitPrice,
        expectedFromTokenAmount: amount,
    })
    if (!quoteValidation.ok) {
        throw new BrowserTradeQuoteError("QUOTE_REJECTED", `Quote rejected: ${quoteValidation.reason}`, 502)
    }

    const assetResponse = await dependencies.getAssetList()
    const assets = isRecord(assetResponse) && Array.isArray(assetResponse.data) ? assetResponse.data : []
    const asset = assets.find((candidate) =>
        isRecord(candidate) &&
        typeof candidate.tokenContractAddress === "string" &&
        candidate.tokenContractAddress.toLowerCase() === input.toToken.toLowerCase()
    )
    if (
        !isRecord(asset) ||
        !isPositiveScalar(asset.referencePrice) ||
        !isPositiveScalar(asset.tokenToShareRatio)
    ) {
        throw new BrowserTradeQuoteError("QUOTE_REJECTED", "Quote rejected: asset reference data is unavailable", 502)
    }
    const referenceValidation = validateQuote({
        usd: quoteValidation.usd,
        referencePrice: asset.referencePrice,
        tokenToShareRatio: asset.tokenToShareRatio,
    })
    if (!referenceValidation.ok || referenceValidation.referenceGap === null) {
        throw new BrowserTradeQuoteError(
            "QUOTE_REJECTED",
            `Quote rejected: ${referenceValidation.ok ? "asset reference data is unavailable" : referenceValidation.reason}`,
            502,
        )
    }

    const quoteFetchedAt = now()
    const expiresAt = quoteFetchedAt + TRADE_QUOTE_TTL_MS
    const fromToken = BSC_USDT_ADDRESS
    const bindingInput = {
        executionId,
        quoteId: rawQuoteId,
        wallet: input.wallet,
        chainId: 56 as const,
        direction: "BUY" as const,
        fromToken,
        toToken: input.toToken,
        amount,
        slippageBps: SLIPPAGE_BPS,
    }
    const quoteBinding = createBrowserTradeBinding(bindingInput, quoteFetchedAt)
    const minimumOutputAmount = (BigInt(outputAmount) * BigInt(10_000 - SLIPPAGE_BPS) / BigInt(10_000)).toString()
    if (minimumOutputAmount === "0") {
        throw new BrowserTradeQuoteError("QUOTE_REJECTED", "Quote rejected: minimum output rounds to zero", 502)
    }

    const intent: BrowserTradeIntent = {
        executionId,
        quoteBindingHash: hashQuoteBinding(quoteBinding),
        quoteId: rawQuoteId,
        walletAddress: input.wallet,
        chainId: 56,
        direction: "BUY",
        inputTokenAddress: fromToken,
        outputTokenAddress: input.toToken,
        inputAmount: amount,
        expectedOutputAmount: outputAmount,
        minimumOutputAmount,
        slippageBps: SLIPPAGE_BPS,
        quoteFetchedAt,
        expiresAt,
        state: "CREATED",
        idempotencyKey: null,
        transactionHash: null,
        providerOrderId: null,
        failureCode: null,
        createdAt: quoteFetchedAt,
        updatedAt: quoteFetchedAt,
    }
    try {
        await store.create(intent)
    } catch {
        throw new BrowserTradeQuoteError(
            "STORE_UNAVAILABLE",
            "Durable trade-intent storage is unavailable; quote retrieval is disabled.",
            503,
        )
    }

    return {
        ...quote,
        quoteId: rawQuoteId,
        status: "QUOTED",
        executionEligibility: "NOT_AVAILABLE",
        quoteFetchedAt,
        executionIntentId: executionId,
        quoteBinding,
        quoteExpiresAt: expiresAt,
        tradeIntent: {
            direction: "BUY",
            chainId: 56,
            fromTokenAddress: fromToken,
            toTokenAddress: input.toToken,
            inputAmount: amount,
            expectedOutputAmount: outputAmount,
            minimumOutputAmount,
            slippageBps: SLIPPAGE_BPS,
        },
    }
}

export async function handleBrowserTradeQuoteRequest(
    request: Request,
    dependencies: BrowserTradeQuoteDependencies,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const { searchParams } = new URL(request.url)
    const toToken = searchParams.get("toToken")
    const amount = searchParams.get("amount")
    const wallet = searchParams.get("userWalletAddress")
    if (!toToken || !amount || !wallet) {
        return {
            status: 400,
            body: { error: "Missing required parameters: toToken, amount, userWalletAddress" },
        }
    }

    try {
        return {
            status: 200,
            body: await createBrowserTradeQuote({ toToken, amount, wallet }, dependencies),
        }
    } catch (error) {
        if (error instanceof BrowserTradeQuoteError) {
            return { status: error.status, body: { error: error.message, code: error.code } }
        }
        const message = error instanceof Error ? error.message : ""
        if (/API error 40375:/i.test(message)) {
            return {
                status: 400,
                body: { error: `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).` },
            }
        }
        return { status: 502, body: { error: "Quote service is temporarily unavailable" } }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPositiveScalar(value: unknown): boolean {
    if (typeof value !== "string" && typeof value !== "number") return false
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0
}

function providerIntegerAmount(value: unknown): string | null {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null
    return normalizeUint256(value)
}

function matchesTokenAddress(value: unknown, expected: string): boolean {
    return typeof value === "string" &&
        EVM_ADDRESS_PATTERN.test(value) &&
        value.toLowerCase() === expected.toLowerCase()
}
