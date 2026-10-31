import { createHash } from "node:crypto"
import { formatUnits, parseUnits } from "viem"
import {
    BSC_USDT_ADDRESS,
    EVM_ADDRESS_PATTERN,
    MINIMUM_ORDER_USDT,
    MINIMUM_ORDER_WEI,
} from "../lib/apiValidation.ts"
import { marketLabel } from "../lib/opportunityMath.ts"
import { createQuoteBinding, verifyQuoteBinding } from "../lib/quoteBinding.ts"
import { isFreshQuote, TRADE_QUOTE_TTL_MS } from "../lib/tradeReadiness.ts"
import { validateQuote } from "../lib/quoteValidation.ts"
import {
    BawCliError,
    buildBawMarketQuoteArgs,
    createBawRunner,
    parseBawMarketQuoteOutput,
    readWalletSnapshot,
    type BawQuoteDirection,
    type BawRunner,
    type BawQuoteOutput,
    type BawWalletSnapshot,
} from "./bawCli.ts"

const BAW_CHAIN_ID = "56"
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)
const AMOUNT_PATTERN = /^\d{1,78}(?:\.\d{1,18})?$/
const SLIPPAGE_BPS_MAX = 500
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD"

export type AgentQuoteInput = {
    direction: BawQuoteDirection
    tokenAddress: string
    amount: string
    chainId: string
    slippageBps: number
}

export type AgentQuoteAsset = {
    tokenContractAddress: string
    underlyingTicker: string
    platformId?: string
    symbol?: string
    referencePrice?: string | number | null
    tokenToShareRatio?: string | number | null
    statusInfo?: { marketStatus?: string | null; openState?: boolean | null }
}

export type AgentQuoteResponse = {
    status: "QUOTED"
    eligibility: "ELIGIBLE" | "REJECTED"
    rejectionReasons: string[]
    direction: BawQuoteDirection
    chainId: string
    tokenAddress: string
    underlyingTicker: string
    walletAddress: string
    fromTokenAddress: string
    toTokenAddress: string
    fromCoinSymbol: string
    fromCoinAmount: string
    toCoinSymbol: string
    toCoinAmount: string
    slippage: number
    slippageBps: number
    tokenPriceUsd: number
    referencePrice: number
    referenceGapPercent: number | null
    quoteFetchedAt: number
    expiresAt: number
    quoteBindingId: string
    quoteBinding: string
    execution: { transactionSubmitted: false; signingRequested: false }
}

export type VerifiedAgentQuote = {
    input: AgentQuoteInput & { amount: string }
    quote: BawQuoteOutput
    response: AgentQuoteResponse
}

export type BawQuoteErrorCode =
    | "INVALID_REQUEST"
    | "UNSUPPORTED_TOKEN"
    | "UNSUPPORTED_CHAIN"
    | "WALLET_DISCONNECTED"
    | "WALLET_ADDRESS_UNAVAILABLE"
    | "MARKET_SESSION_CLOSED"
    | "MARKET_SESSION_UNAVAILABLE"
    | "ORDER_BELOW_MINIMUM"
    | "REFERENCE_DATA_UNAVAILABLE"
    | "BAW_UNAVAILABLE"
    | "BAW_TIMEOUT"
    | "BAW_RATE_LIMITED"
    | "BAW_COMMAND_FAILED"
    | "BAW_COMMAND_NOT_ALLOWED"
    | "INVALID_OUTPUT"
    | "QUOTE_BINDING_UNAVAILABLE"

export class BawQuoteError extends Error {
    readonly code: BawQuoteErrorCode
    readonly status: number

    constructor(code: BawQuoteErrorCode, message: string, status: number) {
        super(message)
        this.name = "BawQuoteError"
        this.code = code
        this.status = status
    }
}

export type ParsedAgentQuoteInput =
    | { ok: true; input: AgentQuoteInput & { amount: string } }
    | { ok: false; reason: string }

export function parseAgentQuoteInput(value: unknown): ParsedAgentQuoteInput {
    if (!isRecord(value)) return { ok: false, reason: "Request body must be a JSON object." }
    const expectedKeys = ["amount", "chainId", "direction", "slippageBps", "tokenAddress"]
    if (!hasExactKeys(value, expectedKeys)) {
        return { ok: false, reason: "Request must contain only direction, tokenAddress, amount, chainId, and slippageBps." }
    }
    if (value.direction !== "BUY" && value.direction !== "SELL") {
        return { ok: false, reason: "Direction must be BUY or SELL." }
    }
    if (typeof value.tokenAddress !== "string" || !EVM_ADDRESS_PATTERN.test(value.tokenAddress)) {
        return { ok: false, reason: "Token address must be a valid EVM address." }
    }
    if (typeof value.chainId !== "string" || value.chainId !== BAW_CHAIN_ID) {
        return { ok: false, reason: "Only BNB Smart Chain mainnet (chain ID 56) is supported." }
    }
    if (typeof value.amount !== "string") {
        return { ok: false, reason: "Amount must be a positive human-readable decimal quantity." }
    }
    const amount = normalizeHumanAmount(value.amount)
    if (!amount) return { ok: false, reason: "Amount must be a positive decimal with no more than 18 decimal places." }
    if (
        typeof value.slippageBps !== "number" ||
        !Number.isSafeInteger(value.slippageBps) ||
        value.slippageBps < 1 ||
        value.slippageBps > SLIPPAGE_BPS_MAX
    ) {
        return { ok: false, reason: `slippageBps must be an integer from 1 to ${SLIPPAGE_BPS_MAX}.` }
    }

    return {
        ok: true,
        input: {
            direction: value.direction,
            tokenAddress: value.tokenAddress,
            amount,
            chainId: value.chainId,
            slippageBps: value.slippageBps,
        },
    }
}

export function slippageBpsToBawPercent(slippageBps: number): string {
    if (!Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps > SLIPPAGE_BPS_MAX) {
        throw new BawQuoteError(
            "INVALID_REQUEST",
            `slippageBps must be an integer from 1 to ${SLIPPAGE_BPS_MAX}.`,
            422,
        )
    }
    return (slippageBps / 100).toFixed(2).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1")
}

export function verifyAgentQuoteResponse(value: unknown, now = Date.now()): VerifiedAgentQuote | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        "status", "eligibility", "rejectionReasons", "direction", "chainId", "tokenAddress",
        "underlyingTicker", "walletAddress", "fromTokenAddress", "toTokenAddress", "fromCoinSymbol", "fromCoinAmount",
        "toCoinSymbol", "toCoinAmount", "slippage", "slippageBps", "tokenPriceUsd", "referencePrice",
        "referenceGapPercent", "quoteFetchedAt", "expiresAt", "quoteBindingId", "quoteBinding", "execution",
    ])) return null

    if (
        value.status !== "QUOTED" ||
        value.eligibility !== "ELIGIBLE" ||
        typeof value.underlyingTicker !== "string" ||
        !/^[A-Za-z0-9._-]{1,28}$/.test(value.underlyingTicker) ||
        !Array.isArray(value.rejectionReasons) ||
        value.rejectionReasons.length !== 0 ||
        typeof value.walletAddress !== "string" ||
        !EVM_ADDRESS_PATTERN.test(value.walletAddress) ||
        typeof value.quoteFetchedAt !== "number" ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt !== value.quoteFetchedAt + TRADE_QUOTE_TTL_MS ||
        typeof value.quoteBindingId !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.quoteBindingId) ||
        typeof value.quoteBinding !== "string" ||
        !isRecord(value.execution) ||
        !hasExactKeys(value.execution, ["transactionSubmitted", "signingRequested"]) ||
        value.execution.transactionSubmitted !== false ||
        value.execution.signingRequested !== false ||
        (value.referenceGapPercent !== null &&
            (typeof value.referenceGapPercent !== "number" || !Number.isFinite(value.referenceGapPercent)))
    ) return null

    const parsedInput = parseAgentQuoteInput({
        direction: value.direction,
        tokenAddress: value.tokenAddress,
        amount: value.fromCoinAmount,
        chainId: value.chainId,
        slippageBps: value.slippageBps,
    })
    if (!parsedInput.ok) return null
    const input = parsedInput.input
    const fromTokenAddress = input.direction === "BUY" ? BSC_USDT_ADDRESS : input.tokenAddress
    const toTokenAddress = input.direction === "BUY" ? input.tokenAddress : BSC_USDT_ADDRESS
    if (
        typeof value.fromTokenAddress !== "string" ||
        value.fromTokenAddress.toLowerCase() !== fromTokenAddress.toLowerCase() ||
        typeof value.toTokenAddress !== "string" ||
        value.toTokenAddress.toLowerCase() !== toTokenAddress.toLowerCase() ||
        typeof value.fromCoinSymbol !== "string" ||
        typeof value.toCoinSymbol !== "string"
    ) return null

    let quote: BawQuoteOutput
    try {
        quote = parseBawMarketQuoteOutput(JSON.stringify({
            success: true,
            data: {
                fromCoinSymbol: value.fromCoinSymbol,
                fromCoinAmount: value.fromCoinAmount,
                toCoinSymbol: value.toCoinSymbol,
                toCoinAmount: value.toCoinAmount,
                slippage: value.slippage,
            },
        }), {
            direction: input.direction,
            amount: input.amount,
            slippagePercent: slippageBpsToBawPercent(input.slippageBps),
            tokenSymbol: input.direction === "BUY" ? value.toCoinSymbol : value.fromCoinSymbol,
        })
    } catch {
        return null
    }

    const expectedQuoteId = createHash("sha256")
        .update(JSON.stringify({ input, quote, walletAddress: value.walletAddress, quoteFetchedAt: value.quoteFetchedAt }))
        .digest("hex")
    if (expectedQuoteId !== value.quoteBindingId || !isFreshQuote({ quoteFetchedAt: value.quoteFetchedAt }, now)) return null

    const binding = verifyQuoteBinding(value.quoteBinding, {
        toToken: toTokenAddress,
        fromToken: fromTokenAddress,
        amount: input.amount,
        wallet: value.walletAddress,
        quoteId: expectedQuoteId,
        chainId: input.chainId,
        direction: input.direction,
        slippageBps: input.slippageBps,
    }, value.quoteFetchedAt)
    if (!binding.ok) return null

    const tokenPriceUsd = positiveFinite(value.tokenPriceUsd)
    const referencePrice = positiveFinite(value.referencePrice)
    if (
        tokenPriceUsd === null ||
        referencePrice === null ||
        typeof value.slippage !== "number" ||
        !Number.isFinite(value.slippage)
    ) return null
    const tokenAmount = input.direction === "BUY" ? quote.toCoinAmount : quote.fromCoinAmount
    const usdtAmount = input.direction === "BUY" ? quote.fromCoinAmount : quote.toCoinAmount
    const computedPrice = Number(usdtAmount) / Number(tokenAmount)
    if (!Number.isFinite(computedPrice) || Math.abs(computedPrice - tokenPriceUsd) > Math.max(1e-10, computedPrice * 1e-10)) {
        return null
    }

    return {
        input,
        quote,
        response: {
            status: "QUOTED",
            eligibility: "ELIGIBLE",
            rejectionReasons: [],
            direction: input.direction,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            underlyingTicker: value.underlyingTicker,
            walletAddress: value.walletAddress,
            fromTokenAddress,
            toTokenAddress,
            fromCoinSymbol: quote.fromCoinSymbol,
            fromCoinAmount: quote.fromCoinAmount,
            toCoinSymbol: quote.toCoinSymbol,
            toCoinAmount: quote.toCoinAmount,
            slippage: quote.slippage,
            slippageBps: input.slippageBps,
            tokenPriceUsd,
            referencePrice,
            referenceGapPercent: value.referenceGapPercent,
            quoteFetchedAt: value.quoteFetchedAt,
            expiresAt: value.expiresAt,
            quoteBindingId: expectedQuoteId,
            quoteBinding: value.quoteBinding,
            execution: { transactionSubmitted: false, signingRequested: false },
        },
    }
}

export async function getBawQuote(
    request: AgentQuoteInput,
    dependencies: {
        runner?: BawRunner
        readSnapshot?: (runner: BawRunner, now: () => number) => Promise<BawWalletSnapshot>
        resolveAsset?: (tokenAddress: string) => Promise<AgentQuoteAsset | null>
        now?: () => number
    } = {},
): Promise<AgentQuoteResponse> {
    const parsedRequest = parseAgentQuoteInput(request)
    if (!parsedRequest.ok) throw new BawQuoteError("INVALID_REQUEST", parsedRequest.reason, 422)
    const input = parsedRequest.input
    const now = dependencies.now ?? Date.now
    const runner = dependencies.runner ?? createBawRunner()
    const snapshot = await (dependencies.readSnapshot ?? ((cli, clock) => readWalletSnapshot({ runner: cli, now: clock })))(runner, now)

    if (!snapshot.connected) {
        throw new BawQuoteError("WALLET_DISCONNECTED", "The Binance Agentic Wallet session is not connected.", 409)
    }
    const chainAvailable = snapshot.chains.some((chain) => chain.binanceChainId === BAW_CHAIN_ID)
    const walletAddress = snapshot.addresses.find((address) => address.binanceChainId === BAW_CHAIN_ID)?.address
    if (!chainAvailable || !walletAddress || !EVM_ADDRESS_PATTERN.test(walletAddress) || walletAddress.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
        throw new BawQuoteError("WALLET_ADDRESS_UNAVAILABLE", "A connected BAW wallet address for BNB Smart Chain mainnet is unavailable.", 409)
    }

    const resolveAsset = dependencies.resolveAsset
    if (!resolveAsset) {
        throw new BawQuoteError("UNSUPPORTED_TOKEN", "Spot-token verification is unavailable.", 503)
    }
    const asset = await resolveAsset(input.tokenAddress)
    if (
        !asset ||
        !EVM_ADDRESS_PATTERN.test(asset.tokenContractAddress) ||
        asset.tokenContractAddress.toLowerCase() !== input.tokenAddress.toLowerCase() ||
        input.tokenAddress.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase()
    ) {
        throw new BawQuoteError("UNSUPPORTED_TOKEN", "Only a supported WOLV spot token can be quoted.", 422)
    }

    const marketStatus = marketLabel({ statusInfo: asset.statusInfo })
    if (marketStatus === "closed") {
        throw new BawQuoteError("MARKET_SESSION_CLOSED", "The token's market session is closed.", 422)
    }
    if (marketStatus !== "open" && marketStatus !== "regular") {
        throw new BawQuoteError("MARKET_SESSION_UNAVAILABLE", "The token's market session is not confirmed open.", 422)
    }

    const referencePrice = positiveFinite(asset.referencePrice)
    const tokenToShareRatio = positiveFinite(asset.tokenToShareRatio)
    if (referencePrice === null || tokenToShareRatio === null) {
        throw new BawQuoteError("REFERENCE_DATA_UNAVAILABLE", "A valid reference price and token-to-share ratio are required.", 422)
    }

    const amountWei = BigInt(parseUnits(input.amount, 18))
    if (input.direction === "BUY" && amountWei < MINIMUM_ORDER_WEI) {
        throw new BawQuoteError(
            "ORDER_BELOW_MINIMUM",
            `Minimum order amount is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).`,
            422,
        )
    }
    const amountNumber = Number(input.amount)
    const estimatedSellValue = amountNumber * referencePrice
    if (
        input.direction === "SELL" &&
        (!Number.isFinite(amountNumber) || !Number.isFinite(estimatedSellValue) || estimatedSellValue < Number(MINIMUM_ORDER_USDT))
    ) {
        throw new BawQuoteError(
            "ORDER_BELOW_MINIMUM",
            `Estimated sell value must be at least ${MINIMUM_ORDER_USDT} USDT using the current reference price.`,
            422,
        )
    }

    const tokenSymbol = getBawTokenSymbol(asset)
    const underlyingTicker = /^[A-Za-z0-9._-]{1,28}$/.test(asset.underlyingTicker) ? asset.underlyingTicker : null
    if (!tokenSymbol || !underlyingTicker) {
        throw new BawQuoteError("UNSUPPORTED_TOKEN", "The spot token has no unambiguous supported symbol mapping.", 422)
    }

    const slippagePercent = slippageBpsToBawPercent(input.slippageBps)
    const args = buildBawMarketQuoteArgs({
        direction: input.direction,
        tokenAddress: input.tokenAddress,
        amount: input.amount,
        chainId: input.chainId,
        slippagePercent,
    })
    let stdout: string
    try {
        ({ stdout } = await runner(args))
    } catch (error) {
        if (error instanceof BawCliError) throw error
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new BawCliError("BAW_UNAVAILABLE", "quote")
        }
        throw new BawCliError("BAW_COMMAND_FAILED", "quote")
    }
    const quote = parseBawMarketQuoteOutput(stdout, {
        direction: input.direction,
        amount: input.amount,
        slippagePercent,
        tokenSymbol,
    })

    const fromTokenAddress = input.direction === "BUY" ? BSC_USDT_ADDRESS : input.tokenAddress
    const toTokenAddress = input.direction === "BUY" ? input.tokenAddress : BSC_USDT_ADDRESS
    const fromAmount = Number(quote.fromCoinAmount)
    const toAmount = Number(quote.toCoinAmount)
    const tokenAmount = input.direction === "BUY" ? toAmount : fromAmount
    const usdtAmount = input.direction === "BUY" ? fromAmount : toAmount
    const tokenPriceUsd = usdtAmount / tokenAmount
    const rejectionReasons: string[] = []
    let referenceGapPercent: number | null = null

    if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) {
        throw new BawCliError("INVALID_OUTPUT", "quote")
    }
    if (input.direction === "SELL" && BigInt(parseUnits(quote.toCoinAmount, 18)) < MINIMUM_ORDER_WEI) {
        rejectionReasons.push(`Quoted sell proceeds are below the ${MINIMUM_ORDER_USDT} USDT minimum order amount.`)
    }
    const quoteValidation = validateQuote({
        usd: tokenPriceUsd,
        referencePrice,
        tokenToShareRatio,
    })
    if (!quoteValidation.ok) {
        rejectionReasons.push(quoteValidation.reason)
    } else if (quoteValidation.referenceGap === null) {
        rejectionReasons.push("The quote could not be compared with the reference price.")
    } else {
        referenceGapPercent = quoteValidation.referenceGap
    }
    const quoteFetchedAt = now()
    if (!isFreshQuote({ quoteFetchedAt }, now())) {
        rejectionReasons.push("The quote expired before it could be returned.")
    }
    const quoteId = createHash("sha256")
        .update(JSON.stringify({ input, quote, walletAddress, quoteFetchedAt }))
        .digest("hex")
    const bindingInput = {
        toToken: toTokenAddress,
        fromToken: fromTokenAddress,
        amount: input.amount,
        wallet: walletAddress,
        quoteId,
        chainId: input.chainId,
        direction: input.direction,
        slippageBps: input.slippageBps,
    }
    let quoteBinding: string
    try {
        quoteBinding = createQuoteBinding(bindingInput, quoteFetchedAt)
        const verification = verifyQuoteBinding(quoteBinding, bindingInput, quoteFetchedAt)
        if (!verification.ok) {
            throw new BawQuoteError("QUOTE_BINDING_UNAVAILABLE", "Quote integrity binding could not be verified.", 503)
        }
    } catch (error) {
        if (error instanceof BawQuoteError) throw error
        throw new BawQuoteError("QUOTE_BINDING_UNAVAILABLE", "Quote integrity binding is not configured.", 503)
    }

    return {
        status: "QUOTED",
        eligibility: rejectionReasons.length === 0 ? "ELIGIBLE" : "REJECTED",
        rejectionReasons,
        direction: input.direction,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        underlyingTicker,
        walletAddress,
        fromTokenAddress,
        toTokenAddress,
        fromCoinSymbol: quote.fromCoinSymbol,
        fromCoinAmount: quote.fromCoinAmount,
        toCoinSymbol: quote.toCoinSymbol,
        toCoinAmount: quote.toCoinAmount,
        slippage: quote.slippage,
        slippageBps: input.slippageBps,
        tokenPriceUsd,
        referencePrice,
        referenceGapPercent,
        quoteFetchedAt,
        expiresAt: quoteFetchedAt + TRADE_QUOTE_TTL_MS,
        quoteBindingId: quoteId,
        quoteBinding,
        execution: { transactionSubmitted: false, signingRequested: false },
    }
}

function normalizeHumanAmount(value: string): string | null {
    if (!AMOUNT_PATTERN.test(value)) return null
    try {
        const units = parseUnits(value, 18)
        if (units <= BigInt(0) || units > UINT256_MAX) return null
        return formatUnits(units, 18).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
    } catch {
        return null
    }
}

function positiveFinite(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getBawTokenSymbol(asset: AgentQuoteAsset): string | null {
    if (asset.symbol !== undefined) {
        return typeof asset.symbol === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(asset.symbol)
            ? asset.symbol
            : null
    }
    if (!/^[A-Za-z0-9._-]{1,28}$/.test(asset.underlyingTicker)) return null

    const suffixByPlatform: Record<string, string> = {
        ondo: "on",
        bstock: "B",
        xstock: "x",
        xstocks: "x",
    }
    const suffix = asset.platformId ? suffixByPlatform[asset.platformId.toLowerCase()] : undefined
    return suffix ? `${asset.underlyingTicker}${suffix}` : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(record)
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key))
}
