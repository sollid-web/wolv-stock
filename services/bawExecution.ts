import { createHash, randomBytes, randomUUID } from "node:crypto"
import { formatUnits, parseUnits } from "viem"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN } from "../lib/apiValidation.ts"
import { verifyQuoteBinding } from "../lib/quoteBinding.ts"
import {
    BawCliError,
    buildBawMarketOrderListArgs,
    buildBawMarketOrderReconciliationArgs,
    buildBawMarketSwapArgs,
    createBawRunner,
    parseBawMarketOrderListOutput,
    parseBawMarketOrderHistoryOutput,
    parseBawMarketOrderSubmitOutput,
    readWalletSnapshot,
    type BawRunner,
    type BawWalletSnapshot,
} from "./bawCli.ts"
import {
    BawExecutionStoreError,
    getDefaultBawExecutionStore,
    type BawExecutionRecord,
    type BawExecutionStorePort,
} from "./bawExecutionStore.ts"
import {
    getBawQuote,
    slippageBpsToBawPercent,
    verifyAgentQuoteResponse,
    type AgentQuoteAsset,
    type AgentQuoteResponse,
} from "./bawQuote.ts"

const BAW_CHAIN_ID = "56"
const BAW_NATIVE_BNB_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
const APPROVAL_TTL_MS = 15_000
const ORDER_POLL_TIMEOUT_MS = 30_000
const MAX_ORDER_POLLS = 15
const MAX_CONFIGURED_ORDER_USD = 1_000
const MAX_CONFIGURED_DAILY_USD = 5_000
const MAX_CONFIGURED_SLIPPAGE_BPS = 100
const MIN_BNB_RESERVE = parseUnits("0.01", 18)
const DECIMAL_AMOUNT = /^\d{1,78}(?:\.\d{1,18})?$/
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)
export class BawExecutionError extends Error {
    readonly code: string
    readonly status: number

    constructor(
        code: string,
        message: string,
        status = 409,
    ) {
        super(message)
        this.name = "BawExecutionError"
        this.code = code
        this.status = status
    }
}

export type BawExecutionDependencies = {
    store?: BawExecutionStorePort
    runner?: BawRunner
    readSnapshot?: (runner: BawRunner, now: () => number) => Promise<BawWalletSnapshot>
    resolveAsset?: (tokenAddress: string) => Promise<AgentQuoteAsset | null>
    now?: () => number
    sleep?: (milliseconds: number) => Promise<void>
    environment?: NodeJS.ProcessEnv
}

export type BawApprovalResult = {
    executionId: string
    approvalReference: string
    approvalToken: string
    expiresAt: number
    trade: Pick<
        BawExecutionRecord,
        | "walletAddress" | "tokenAddress" | "tokenSymbol" | "direction" | "chainId"
        | "fromTokenAddress" | "toTokenAddress" | "requestedInputAmount"
        | "expectedOutputAmount" | "minimumOutputAmount" | "slippageBps"
        | "quoteExpiresAt" | "referencePrice"
    >
}

export function sanitizeBawExecutionRecord(record: BawExecutionRecord): Omit<BawExecutionRecord, "quoteBinding"> {
    const { quoteBinding: _quoteBinding, ...safeRecord } = record
    void _quoteBinding
    return safeRecord
}

export async function createBawExecutionApproval(
    quoteValue: unknown,
    dependencies: BawExecutionDependencies,
): Promise<BawApprovalResult> {
    const config = getExecutionConfig(dependencies.environment ?? process.env)
    const store = getStore(dependencies.store)
    const now = dependencies.now ?? Date.now
    const runner = dependencies.runner ?? createBawRunner()
    if (!dependencies.resolveAsset) throw new BawExecutionError("ASSET_RESOLVER_UNAVAILABLE", "WOLV spot-asset verification is unavailable.", 503)
    const verified = verifyAgentQuoteResponse(quoteValue, now())
    if (!verified) throw new BawExecutionError("QUOTE_INVALID", "The quote is malformed, expired, or its integrity binding is invalid.", 409)

    const snapshot = await getReadyWalletSnapshot(runner, now, dependencies.readSnapshot)
    const quote = await revalidateQuote(verified.response, runner, snapshot, now, dependencies.resolveAsset)
    validateWalletFunds(snapshot, quote, config.minBnbReserve)
    await validateLimits(store, quote, config, now())

    if (!quote.toTokenMetadata) {
        throw new BawExecutionError("UNSUPPORTED_TOKEN", "The output token's verified decimal metadata is required before a BAW approval can be created.", 422)
    }
    const outputDecimals = quote.toTokenMetadata.decimals
    const amountOut = parsePositiveAmount(quote.toCoinAmount, outputDecimals)
    const minimumOutputAmount = formatUnits(
        amountOut * BigInt(10_000 - quote.slippageBps) / BigInt(10_000),
        outputDecimals,
    )
    const approvalToken = randomBytes(32).toString("base64url")
    const executionId = randomUUID()
    const approvalReference = randomUUID()
    const expiresAt = Math.min(now() + APPROVAL_TTL_MS, quote.expiresAt)
    if (expiresAt <= now()) {
        throw new BawExecutionError("QUOTE_EXPIRED", "The quote expires too soon to approve.", 409)
    }
    const inputAmount = quote.fromCoinAmount
    const notionalUsd = quote.direction === "BUY" ? Number(inputAmount) : Number(quote.toCoinAmount)
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
        throw new BawExecutionError("INVALID_NOTIONAL", "A valid USDT trade value could not be established.", 422)
    }
    const record: BawExecutionRecord = {
        executionId,
        approvalReference,
        quoteReference: quote.quoteBindingId,
        quoteBinding: quote.quoteBinding,
        quoteFetchedAt: quote.quoteFetchedAt,
        referencePrice: quote.referencePrice,
        tokenPriceUsd: quote.tokenPriceUsd,
        referenceGapPercent: quote.referenceGapPercent,
        walletAddress: quote.walletAddress,
        tokenAddress: quote.tokenAddress,
        tokenDecimals: quote.tokenDecimals,
        fromTokenDecimals: quote.fromTokenMetadata.decimals,
        toTokenDecimals: quote.toTokenMetadata.decimals,
        underlyingTicker: quote.underlyingTicker,
        tokenSymbol: quote.direction === "BUY" ? quote.toCoinSymbol : quote.fromCoinSymbol,
        fromCoinSymbol: quote.fromCoinSymbol,
        toCoinSymbol: quote.toCoinSymbol,
        direction: quote.direction,
        chainId: BAW_CHAIN_ID,
        fromTokenAddress: quote.fromTokenAddress,
        toTokenAddress: quote.toTokenAddress,
        requestedInputAmount: inputAmount,
        expectedOutputAmount: quote.toCoinAmount,
        minimumOutputAmount,
        slippageBps: quote.slippageBps,
        quoteExpiresAt: quote.expiresAt,
        notionalUsd,
        state: "APPROVAL_REQUIRED",
        securityAuditAcknowledged: false,
        providerOrderId: null,
        actualExecutedInput: null,
        actualReceivedOutput: null,
        refunds: [],
        averageExecutionPrice: null,
        transactionHash: null,
        failureReason: null,
        submittedAt: null,
        completedAt: null,
    }
    try {
        await store.createApproval(record, hashSecret(approvalToken), expiresAt, now())
    } catch (error) {
        if (error instanceof BawExecutionStoreError) {
            throw new BawExecutionError(error.code, "Another BAW execution is active or persistent storage is unavailable.", 409)
        }
        throw error
    }

    return {
        executionId,
        approvalReference,
        approvalToken,
        expiresAt,
        trade: {
            walletAddress: record.walletAddress,
            tokenAddress: record.tokenAddress,
            tokenSymbol: record.tokenSymbol,
            direction: record.direction,
            chainId: record.chainId,
            fromTokenAddress: record.fromTokenAddress,
            toTokenAddress: record.toTokenAddress,
            requestedInputAmount: record.requestedInputAmount,
            expectedOutputAmount: record.expectedOutputAmount,
            minimumOutputAmount: record.minimumOutputAmount,
            slippageBps: record.slippageBps,
            quoteExpiresAt: record.quoteExpiresAt,
            referencePrice: record.referencePrice,
        },
    }
}

export async function executeApprovedBawTrade(
    request: { executionId: string; approvalToken: string; securityAuditAcknowledged: boolean },
    dependencies: BawExecutionDependencies,
): Promise<BawExecutionRecord> {
    const config = getExecutionConfig(dependencies.environment ?? process.env)
    const store = getStore(dependencies.store)
    const now = dependencies.now ?? Date.now
    const runner = dependencies.runner ?? createBawRunner()
    if (!dependencies.resolveAsset) throw new BawExecutionError("ASSET_RESOLVER_UNAVAILABLE", "WOLV spot-asset verification is unavailable.", 503)
    if (
        !isUuid(request.executionId) ||
        typeof request.approvalToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(request.approvalToken) ||
        request.securityAuditAcknowledged !== true
    ) throw new BawExecutionError("APPROVAL_INVALID", "A valid one-time approval is required.", 401)

    let record: BawExecutionRecord
    try {
        record = await store.consumeApproval(request.executionId, hashSecret(request.approvalToken), now())
    } catch (error) {
        if (error instanceof BawExecutionStoreError) {
            throw new BawExecutionError(`APPROVAL_${error.code}`, "Approval is missing, expired, already used, or another execution is active.", 409)
        }
        throw error
    }

    try {
        record.securityAuditAcknowledged = true
        await store.update(record)
        if (now() >= record.quoteExpiresAt) {
            return await failRecord(store, record, "Quote expired before the order could be submitted.", now())
        }
        const quoteBinding = verifyQuoteBinding(record.quoteBinding, {
            toToken: record.toTokenAddress,
            fromToken: record.fromTokenAddress,
            amount: record.requestedInputAmount,
            wallet: record.walletAddress,
            quoteId: record.quoteReference,
            chainId: record.chainId,
            direction: record.direction,
            slippageBps: record.slippageBps,
        }, now())
        if (!quoteBinding.ok || quoteBinding.issuedAt !== record.quoteFetchedAt) {
            return await failRecord(store, record, "Quote integrity verification failed.", now())
        }

        const snapshot = await getReadyWalletSnapshot(runner, now, dependencies.readSnapshot)
        if (snapshot.addresses.find((address) => address.binanceChainId === BAW_CHAIN_ID)?.address.toLowerCase()
            !== record.walletAddress.toLowerCase()) {
            return await failRecord(store, record, "The connected BAW operator wallet changed after approval.", now())
        }
        const freshQuote = await getBawQuote({
            direction: record.direction,
            tokenAddress: record.tokenAddress,
            amount: record.requestedInputAmount,
            chainId: record.chainId,
            slippageBps: record.slippageBps,
        }, {
            runner,
            readSnapshot: async () => snapshot,
            resolveAsset: dependencies.resolveAsset,
            now,
        })
        if (!sameApprovedQuote(record, freshQuote)) {
            return await failRecord(store, record, "The live quote changed after approval. Request and approve a new quote.", now())
        }
        validateWalletFunds(snapshot, freshQuote, config.minBnbReserve)
        await validateLimits(store, freshQuote, config, now(), record.executionId)

        const amount = freshQuote.fromCoinAmount
        const slippagePercent = slippageBpsToBawPercent(record.slippageBps)
        const args = buildBawMarketSwapArgs({
            direction: record.direction,
            tokenAddress: record.tokenAddress,
            amount,
            chainId: record.chainId,
            slippagePercent,
        })
        record.state = "SUBMITTING"
        record.submittedAt = now()
        await store.update(record)
        let orderId: string
        try {
            const result = await runner(args)
            orderId = parseBawMarketOrderSubmitOutput(result.stdout)
        } catch (error) {
            const uncertain = !(error instanceof BawCliError) ||
                ["BAW_TIMEOUT", "BAW_COMMAND_FAILED", "INVALID_OUTPUT"].includes(error.code)
            record.state = uncertain ? "UNKNOWN" : "FAILED"
            record.failureReason = error instanceof BawCliError
                ? `BAW submission could not be confirmed (${error.code}).`
                : "BAW submission outcome could not be confirmed."
            record.completedAt = record.state === "FAILED" ? now() : null
            await store.update(record)
            return record
        }
        record.providerOrderId = orderId
        record.state = "SUBMITTED"
        await store.update(record)
        return await monitorBawOrder(record, runner, store, now, dependencies.sleep)
    } catch (error) {
        if (error instanceof BawExecutionError) {
            record.state = "FAILED"
            record.failureReason = error.message
            record.completedAt = now()
            await store.update(record)
            throw error
        }
        record.state = "FAILED"
        record.failureReason = error instanceof BawCliError
            ? `BAW preflight failed (${error.code}).`
            : "BAW preflight or execution failed."
        record.completedAt = record.state === "FAILED" ? now() : null
        await store.update(record)
        throw error
    }
}

export async function reconcileBawExecution(
    executionId: string,
    dependencies: BawExecutionDependencies,
): Promise<BawExecutionRecord> {
    const store = getStore(dependencies.store)
    const record = await store.get(executionId)
    if (!record) throw new BawExecutionError("EXECUTION_NOT_FOUND", "Execution record was not found.", 404)
    if (!["APPROVED", "SUBMITTING", "SUBMITTED", "PENDING", "UNKNOWN"].includes(record.state)) return record
    const runner = dependencies.runner ?? createBawRunner()
    if (!record.providerOrderId) {
        if (!record.submittedAt) {
            if (record.state === "APPROVED") {
                record.state = "FAILED"
                record.failureReason = "The process stopped after approval but before recording a submission attempt. No order was submitted."
                record.completedAt = (dependencies.now ?? Date.now)()
                await store.update(record)
                return record
            }
            record.state = "UNKNOWN"
            record.failureReason = "The process stopped before a submission timestamp was recorded; manual reconciliation is required."
            await store.update(record)
            return record
        }
        return reconcileUncertainSubmission(record, runner, store, dependencies.now ?? Date.now, dependencies.sleep)
    }
    return monitorBawOrder(record, runner, store, dependencies.now ?? Date.now, dependencies.sleep)
}

async function reconcileUncertainSubmission(
    record: BawExecutionRecord,
    runner: BawRunner,
    store: BawExecutionStorePort,
    now: () => number,
    sleep: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<BawExecutionRecord> {
    if (!record.submittedAt) return record
    try {
        const history = await runner(buildBawMarketOrderReconciliationArgs({
            fromToken: record.fromTokenAddress,
            toToken: record.toTokenAddress,
            startTime: record.submittedAt,
            endTime: now(),
        }))
        const candidates = parseBawMarketOrderHistoryOutput(history.stdout).filter((order) =>
            order.chain === record.chainId &&
            order.fromToken.toLowerCase() === record.fromTokenAddress.toLowerCase() &&
            order.toToken.toLowerCase() === record.toTokenAddress.toLowerCase() &&
            BigInt(parseUnits(order.fromTokenQty, 18)) === BigInt(parseUnits(record.requestedInputAmount, 18)) &&
            Date.parse(order.bookTime) >= record.submittedAt! &&
            Date.parse(order.bookTime) <= now()
        )
        if (candidates.length !== 1) {
            record.failureReason = candidates.length
                ? "More than one matching BAW history entry exists; manual reconciliation is required."
                : "No unique matching BAW order was found; do not retry this execution."
            await store.update(record)
            return record
        }
        record.providerOrderId = candidates[0].orderId
        record.state = "SUBMITTED"
        await store.update(record)
        return monitorBawOrder(record, runner, store, now, sleep)
    } catch {
        record.failureReason = "BAW order history could not reconcile the uncertain submission; do not retry."
        await store.update(record)
        return record
    }
}

export function compareBawOutputQuantity(
    actualOutput: string | null | undefined,
): { state: "FINISHED_UNVERIFIED"; reason: string; actualReceivedOutput: string | null } {
    if (actualOutput === null || actualOutput === undefined || actualOutput.trim() === "") {
        return {
            state: "FINISHED_UNVERIFIED",
            reason: "BAW reported FINISHED without actual output quantity; fill status cannot be verified.",
            actualReceivedOutput: null,
        }
    }
    return {
        state: "FINISHED_UNVERIFIED",
        reason: "BAW actual-output units and independent settlement semantics are not documented; fill status cannot be verified.",
        actualReceivedOutput: actualOutput,
    }
}

async function monitorBawOrder(
    record: BawExecutionRecord,
    runner: BawRunner,
    store: BawExecutionStorePort,
    now: () => number,
    sleep: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<BawExecutionRecord> {
    if (!record.providerOrderId) return record
    const startedAt = now()
    for (let attempt = 0; attempt < MAX_ORDER_POLLS; attempt += 1) {
        try {
            const response = await runner(buildBawMarketOrderListArgs(record.providerOrderId))
            const order = parseBawMarketOrderListOutput(response.stdout, {
                orderId: record.providerOrderId,
                fromToken: record.fromTokenAddress,
                toToken: record.toTokenAddress,
                amount: record.requestedInputAmount,
            })
            record.actualReceivedOutput = order.toTokenActualQty ?? null
            record.refunds = order.refund ?? []
            record.transactionHash = order.txHash ?? null
            if (order.status === "FAILED") {
                record.state = "FAILED"
                record.failureReason = "BAW reported FAILED."
                record.completedAt = now()
                await store.update(record)
                return record
            }
            if (order.status === "FINISHED") {
                const comparison = compareBawOutputQuantity(order.toTokenActualQty)
                record.actualReceivedOutput = comparison.actualReceivedOutput
                record.state = comparison.state
                record.failureReason = comparison.reason
                record.completedAt = now()
                await store.update(record)
                return record
            }
            record.state = "PENDING"
            await store.update(record)
        } catch {
            record.state = "UNKNOWN"
            record.failureReason = "The BAW order status could not be established; do not submit another order."
            await store.update(record)
            return record
        }
        if (now() - startedAt >= ORDER_POLL_TIMEOUT_MS) break
        await (sleep ?? delay)(2_000)
    }
    record.state = "PENDING"
    await store.update(record)
    return record
}

async function getReadyWalletSnapshot(
    runner: BawRunner,
    now: () => number,
    readSnapshot: BawExecutionDependencies["readSnapshot"],
): Promise<BawWalletSnapshot> {
    const snapshot = await (readSnapshot ?? ((cli, clock) => readWalletSnapshot({ runner: cli, now: clock })))(runner, now)
    if (!snapshot.connected) throw new BawExecutionError("WALLET_DISCONNECTED", "The BAW operator wallet is disconnected.", 409)
    if (snapshot.errors.length) throw new BawExecutionError("WALLET_SNAPSHOT_INCOMPLETE", "BAW wallet status, address, balances, or settings could not be verified.", 503)
    if (!snapshot.chains.some((chain) => chain.binanceChainId === BAW_CHAIN_ID)) {
        throw new BawExecutionError("UNSUPPORTED_CHAIN", "The connected BAW wallet does not report BNB Smart Chain.", 409)
    }
    const settings = snapshot.settings
    if (!settings || Date.parse(settings.sessionExpireTime) <= now()) {
        throw new BawExecutionError("WALLET_SESSION_EXPIRED", "The BAW operator session is expired or has no verified expiry.", 409)
    }
    const address = snapshot.addresses.find((candidate) => candidate.binanceChainId === BAW_CHAIN_ID)?.address
    if (!address || !EVM_ADDRESS_PATTERN.test(address)) {
        throw new BawExecutionError("WALLET_ADDRESS_UNAVAILABLE", "The BAW operator address for BNB Smart Chain could not be verified.", 409)
    }
    return snapshot
}

async function revalidateQuote(
    original: AgentQuoteResponse,
    runner: BawRunner,
    snapshot: BawWalletSnapshot,
    now: () => number,
    resolveAsset: BawExecutionDependencies["resolveAsset"],
) {
    const fresh = await getBawQuote({
        direction: original.direction,
        tokenAddress: original.tokenAddress,
        amount: original.fromCoinAmount,
        chainId: original.chainId,
        slippageBps: original.slippageBps,
    }, {
        runner,
        readSnapshot: async () => snapshot,
        resolveAsset,
        now,
    })
    if (!sameApprovedQuote({
        walletAddress: original.walletAddress,
        tokenAddress: original.tokenAddress,
        underlyingTicker: original.underlyingTicker,
        direction: original.direction,
        fromTokenAddress: original.fromTokenAddress,
        toTokenAddress: original.toTokenAddress,
        requestedInputAmount: original.fromCoinAmount,
        expectedOutputAmount: original.toCoinAmount,
        slippageBps: original.slippageBps,
        referencePrice: original.referencePrice,
        tokenPriceUsd: original.tokenPriceUsd,
        referenceGapPercent: original.referenceGapPercent,
        fromCoinSymbol: original.fromCoinSymbol,
        toCoinSymbol: original.toCoinSymbol,
        fromTokenDecimals: original.fromTokenMetadata.decimals,
        toTokenDecimals: original.toTokenMetadata.decimals,
    }, fresh)) {
        throw new BawExecutionError("QUOTE_CHANGED", "The live quote changed. Request a new quote before approval.", 409)
    }
    return fresh
}

function sameApprovedQuote(
    record: Pick<BawExecutionRecord,
        | "walletAddress" | "tokenAddress" | "direction" | "fromTokenAddress" | "toTokenAddress"
        | "underlyingTicker" | "requestedInputAmount" | "expectedOutputAmount" | "slippageBps" | "referencePrice"
        | "tokenPriceUsd" | "referenceGapPercent" | "fromCoinSymbol" | "toCoinSymbol"
        | "fromTokenDecimals" | "toTokenDecimals"
    >,
    quote: AgentQuoteResponse,
): boolean {
    return quote.eligibility === "ELIGIBLE" &&
        quote.walletAddress.toLowerCase() === record.walletAddress.toLowerCase() &&
        quote.tokenAddress.toLowerCase() === record.tokenAddress.toLowerCase() &&
        quote.underlyingTicker === record.underlyingTicker &&
        quote.direction === record.direction &&
        quote.fromTokenAddress.toLowerCase() === record.fromTokenAddress.toLowerCase() &&
        quote.toTokenAddress.toLowerCase() === record.toTokenAddress.toLowerCase() &&
        quote.fromCoinAmount === record.requestedInputAmount &&
        quote.toCoinAmount === record.expectedOutputAmount &&
        quote.fromCoinSymbol === record.fromCoinSymbol &&
        quote.toCoinSymbol === record.toCoinSymbol &&
        quote.fromTokenMetadata.decimals === record.fromTokenDecimals &&
        quote.toTokenMetadata.decimals === record.toTokenDecimals &&
        quote.slippageBps === record.slippageBps &&
        quote.referencePrice === record.referencePrice &&
        quote.tokenPriceUsd === record.tokenPriceUsd &&
        quote.referenceGapPercent === record.referenceGapPercent
}

function validateWalletFunds(snapshot: BawWalletSnapshot, quote: AgentQuoteResponse, minimumBnbReserve: string): void {
    const from = quote.direction === "BUY" ? BSC_USDT_ADDRESS : quote.tokenAddress
    const inputBalance = snapshot.balances.find((balance) =>
        balance.binanceChainId === BAW_CHAIN_ID &&
        balance.contractAddress.toLowerCase() === from.toLowerCase()
    )
    const inputDecimals = quote.fromTokenMetadata.decimals
    const availableInput = inputBalance ? parseBalanceAmount(inputBalance.balance, inputDecimals) : null
    if (availableInput === null || availableInput < parsePositiveAmount(quote.fromCoinAmount, inputDecimals)) {
        throw new BawExecutionError("INSUFFICIENT_TRADE_BALANCE", "BAW does not report sufficient source-token balance.", 409)
    }
    const bnbBalance = snapshot.balances.find((balance) =>
        balance.binanceChainId === BAW_CHAIN_ID &&
        balance.contractAddress.toLowerCase() === BAW_NATIVE_BNB_ADDRESS.toLowerCase() &&
        balance.symbol.toUpperCase() === "BNB"
    )
    const availableBnb = bnbBalance ? parseBalanceAmount(bnbBalance.balance) : null
    if (availableBnb === null || availableBnb < parsePositiveAmount(minimumBnbReserve)) {
        throw new BawExecutionError("INSUFFICIENT_FEE_RESERVE", "BAW does not report the configured BNB fee reserve.", 409)
    }
    const settings = snapshot.settings
    const notionalUsd = quote.direction === "BUY" ? Number(quote.fromCoinAmount) : Number(quote.toCoinAmount)
    if (!settings || !Number.isFinite(notionalUsd) || notionalUsd > settings.quotaLeft) {
        throw new BawExecutionError("WALLET_DAILY_LIMIT", "The requested trade exceeds BAW's reported remaining daily quota.", 409)
    }
}

async function validateLimits(
    store: BawExecutionStorePort,
    quote: AgentQuoteResponse,
    config: ExecutionConfig,
    now: number,
    excludeExecutionId?: string,
): Promise<void> {
    const notionalUsd = quote.direction === "BUY" ? Number(quote.fromCoinAmount) : Number(quote.toCoinAmount)
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > config.maxOrderUsd) {
        throw new BawExecutionError("ORDER_LIMIT", "The order exceeds the configured per-order maximum.", 409)
    }
    if (quote.slippageBps > config.maxSlippageBps) {
        throw new BawExecutionError("SLIPPAGE_LIMIT", "The quote exceeds the configured maximum execution slippage.", 409)
    }
    const dayStart = new Date(now)
    dayStart.setUTCHours(0, 0, 0, 0)
    if (await store.dailyNotionalSince(dayStart.getTime(), excludeExecutionId) + notionalUsd > config.dailyLimitUsd) {
        throw new BawExecutionError("DAILY_LIMIT", "The order exceeds the configured persistent daily execution limit.", 409)
    }
}

type ExecutionConfig = {
    maxOrderUsd: number
    dailyLimitUsd: number
    maxSlippageBps: number
    minBnbReserve: string
}

function getExecutionConfig(environment: NodeJS.ProcessEnv): ExecutionConfig {
    if (environment.VERCEL === "1") {
        throw new BawExecutionError("PERSISTENT_HOST_REQUIRED", "BAW execution is not available on Vercel serverless.", 503)
    }
    if (environment.BAW_EXECUTION_ENABLED !== "true" || environment.BAW_EXECUTION_KILL_SWITCH !== "false") {
        throw new BawExecutionError("EXECUTION_DISABLED", "BAW order execution is disabled or the kill switch is active.", 503)
    }
    const maxOrderUsd = Number(environment.BAW_EXECUTION_MAX_ORDER_USDT)
    const dailyLimitUsd = Number(environment.BAW_EXECUTION_DAILY_LIMIT_USDT)
    const maxSlippageBps = Number(environment.BAW_EXECUTION_MAX_SLIPPAGE_BPS)
    const minBnbReserve = environment.BAW_EXECUTION_MIN_BNB_RESERVE ?? ""
    if (
        !Number.isFinite(maxOrderUsd) || maxOrderUsd <= 0 || maxOrderUsd > MAX_CONFIGURED_ORDER_USD ||
        !Number.isFinite(dailyLimitUsd) || dailyLimitUsd <= 0 || dailyLimitUsd > MAX_CONFIGURED_DAILY_USD ||
        !Number.isSafeInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > MAX_CONFIGURED_SLIPPAGE_BPS ||
        !DECIMAL_AMOUNT.test(minBnbReserve) ||
        parsePositiveAmount(minBnbReserve) < MIN_BNB_RESERVE
    ) {
        throw new BawExecutionError(
            "EXECUTION_LIMITS_NOT_CONFIGURED",
            "Per-order, daily, slippage, and minimum BNB reserve limits must be configured within hard caps.",
            503,
        )
    }
    return { maxOrderUsd, dailyLimitUsd, maxSlippageBps, minBnbReserve }
}

function parsePositiveAmount(value: string, decimals = 18): bigint {
    if (!DECIMAL_AMOUNT.test(value)) throw new BawExecutionError("INVALID_AMOUNT", "A BAW amount is malformed.", 422)
    try {
        const amount = parseUnits(value, decimals)
        if (amount <= BigInt(0) || amount > UINT256_MAX) throw new Error("amount out of range")
        return amount
    } catch {
        throw new BawExecutionError("INVALID_AMOUNT", "A BAW amount is outside the supported range.", 422)
    }
}

function parseBalanceAmount(value: string, decimals = 18): bigint | null {
    if (!DECIMAL_AMOUNT.test(value)) return null
    try {
        const amount = parseUnits(value, decimals)
        return amount >= BigInt(0) && amount <= UINT256_MAX ? amount : null
    } catch {
        return null
    }
}

async function failRecord(
    store: BawExecutionStorePort,
    record: BawExecutionRecord,
    reason: string,
    now: number,
): Promise<BawExecutionRecord> {
    record.state = "FAILED"
    record.failureReason = reason
    record.completedAt = now
    await store.update(record)
    return record
}

function hashSecret(value: string): string {
    return createHash("sha256").update(value).digest("hex")
}

function getStore(store?: BawExecutionStorePort): BawExecutionStorePort {
    if (store) return store
    try {
        return getDefaultBawExecutionStore()
    } catch (error) {
        if (error instanceof BawExecutionStoreError) {
            throw new BawExecutionError(
                "PERSISTENT_STORAGE_UNAVAILABLE",
                "Durable BAW execution storage is not configured on this host.",
                503,
            )
        }
        throw error
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
