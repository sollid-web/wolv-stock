import { execFile } from "node:child_process"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN } from "../lib/apiValidation.ts"

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 1_000_000
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/
const BAW_QUOTE_AMOUNT_PATTERN = /^\d{1,78}(?:\.\d{1,18})?$/
const BAW_QUOTE_SLIPPAGE_PATTERN = /^(?:0\.(?:0[1-9]|[1-9]\d?)|[1-4](?:\.\d{1,2})?|5(?:\.0{1,2})?)$/
const BAW_ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)

type BawCommand =
    | "wallet status"
    | "wallet address"
    | "wallet chains"
    | "wallet balance"
    | "wallet settings"

type BawExecutableCommand = BawCommand | "market-order quote" | "market-order swap" | "market-order list"

const COMMAND_ARGS: Record<BawCommand, readonly string[]> = {
    "wallet status": ["wallet", "status", "--json"],
    "wallet address": ["wallet", "address", "--json"],
    "wallet chains": ["wallet", "chains", "--json"],
    "wallet balance": ["wallet", "balance", "--json"],
    "wallet settings": ["wallet", "settings", "--json"]
}

export type BawMarketOrder = {
    orderId: string
    chain: string
    fromToken: string
    fromTokenQty: string
    toToken: string
    status: "PENDING" | "FINISHED" | "FAILED"
    toTokenActualQty?: string
    txHash?: string | null
    refund?: { tokenAddress: string; amount: string; symbol: string }[]
    bookTime?: string
}

function isPositiveBawAmount(value: string): boolean {
    if (!BAW_QUOTE_AMOUNT_PATTERN.test(value)) return false
    try {
        const [whole, fraction = ""] = value.split(".")
        const units = BigInt(`${whole}${fraction.padEnd(18, "0")}`)
        return units > BigInt(0) && units <= UINT256_MAX
    } catch {
        return false
    }
}

export type BawMarketOrderInput = BawQuoteCommandInput

export function buildBawMarketSwapArgs(input: BawMarketOrderInput): readonly string[] {
    const quoteArgs = buildBawMarketQuoteArgs(input)
    return [
        "market-order", "swap", ...quoteArgs.slice(2, 12),
        "--mev", "true",
        "--gasLevel", "MEDIUM",
        "--json",
    ]
}

export function buildBawMarketOrderListArgs(orderId: string): readonly string[] {
    if (!BAW_ORDER_ID_PATTERN.test(orderId)) {
        throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "market-order")
    }
    return ["market-order", "list", "--orderId", orderId, "--json"]
}

export function buildBawMarketOrderReconciliationArgs(input: {
    fromToken: string
    toToken: string
    startTime: number
    endTime: number
}): readonly string[] {
    if (
        !EVM_ADDRESS_PATTERN.test(input.fromToken) ||
        !EVM_ADDRESS_PATTERN.test(input.toToken) ||
        input.fromToken.toLowerCase() === input.toToken.toLowerCase() ||
        !Number.isSafeInteger(input.startTime) ||
        !Number.isSafeInteger(input.endTime) ||
        input.startTime < 0 ||
        input.endTime < input.startTime
    ) throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "market-order")
    return [
        "market-order", "list",
        "--fromToken", input.fromToken,
        "--toToken", input.toToken,
        "--startTime", String(input.startTime),
        "--endTime", String(input.endTime),
        "--binanceChainId", "56",
        "--json",
    ]
}

export function parseBawMarketSwapArgs(args: readonly string[]): BawMarketOrderInput | null {
    if (
        args.length !== 17 ||
        args[0] !== "market-order" ||
        args[1] !== "swap" ||
        args[12] !== "--mev" ||
        args[13] !== "true" ||
        args[14] !== "--gasLevel" ||
        args[15] !== "MEDIUM" ||
        args[16] !== "--json"
    ) return null
    const quoteArgs = ["market-order", "quote", ...args.slice(2, 12), "--json"]
    return parseBawMarketQuoteArgs(quoteArgs)
}

export function parseBawMarketOrderListArgs(args: readonly string[]): string | null {
    if (
        args.length !== 5 ||
        args[0] !== "market-order" ||
        args[1] !== "list" ||
        args[2] !== "--orderId" ||
        args[4] !== "--json" ||
        !BAW_ORDER_ID_PATTERN.test(args[3])
    ) return null
    return args[3]
}

function isBawMarketOrderReconciliationArgs(args: readonly string[]): boolean {
    if (
        args.length !== 13 ||
        args[0] !== "market-order" ||
        args[1] !== "list" ||
        args[2] !== "--fromToken" ||
        !EVM_ADDRESS_PATTERN.test(args[3]) ||
        args[4] !== "--toToken" ||
        !EVM_ADDRESS_PATTERN.test(args[5]) ||
        args[3].toLowerCase() === args[5].toLowerCase() ||
        args[6] !== "--startTime" ||
        !/^\d{1,16}$/.test(args[7]) ||
        !Number.isSafeInteger(Number(args[7])) ||
        args[8] !== "--endTime" ||
        !/^\d{1,16}$/.test(args[9]) ||
        !Number.isSafeInteger(Number(args[9])) ||
        Number(args[9]) < Number(args[7]) ||
        args[10] !== "--binanceChainId" ||
        args[11] !== "56" ||
        args[12] !== "--json"
    ) return false
    return true
}

export function parseBawMarketOrderSubmitOutput(stdout: string): string {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout)
    } catch {
        throw new BawCliError("INVALID_OUTPUT", "market-order")
    }
    if (
        !isRecord(parsed) ||
        !hasExactKeys(parsed, ["success", "data"]) ||
        parsed.success !== true ||
        !isRecord(parsed.data) ||
        !hasExactKeys(parsed.data, ["orderId"]) ||
        typeof parsed.data.orderId !== "string" ||
        !BAW_ORDER_ID_PATTERN.test(parsed.data.orderId)
    ) throw new BawCliError("INVALID_OUTPUT", "market-order")
    return parsed.data.orderId
}

export function parseBawMarketOrderListOutput(stdout: string, expected: {
    orderId: string
    fromToken: string
    toToken: string
    amount: string
}): BawMarketOrder {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout)
    } catch {
        throw new BawCliError("INVALID_OUTPUT", "market-order")
    }
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["success", "data"]) || parsed.success !== true ||
        !isRecord(parsed.data) || !Array.isArray(parsed.data.list)) {
        throw new BawCliError("INVALID_OUTPUT", "market-order")
    }
    const matches = parsed.data.list.filter((order): order is Record<string, unknown> =>
        isRecord(order) && order.orderId === expected.orderId
    )
    if (matches.length !== 1) throw new BawCliError("INVALID_OUTPUT", "market-order")
    const order = matches[0]
    if (
        order.orderType !== "market" ||
        order.chain !== "56" ||
        typeof order.fromToken !== "string" ||
        order.fromToken.toLowerCase() !== expected.fromToken.toLowerCase() ||
        typeof order.toToken !== "string" ||
        order.toToken.toLowerCase() !== expected.toToken.toLowerCase() ||
        typeof order.fromTokenQty !== "string" ||
        quoteAmountUnits(order.fromTokenQty) !== quoteAmountUnits(expected.amount) ||
        (order.status !== "PENDING" && order.status !== "FINISHED" && order.status !== "FAILED")
    ) throw new BawCliError("INVALID_OUTPUT", "market-order")

    const result: BawMarketOrder = {
        orderId: expected.orderId,
        chain: "56",
        fromToken: order.fromToken,
        fromTokenQty: order.fromTokenQty,
        toToken: order.toToken,
        status: order.status,
    }
    if (order.toTokenActualQty !== undefined) {
        const quantity = validQuoteAmount(order.toTokenActualQty)
        if (!quantity) throw new BawCliError("INVALID_OUTPUT", "market-order")
        result.toTokenActualQty = quantity
    }
    if (order.txHash !== undefined) {
        if (order.txHash !== null && (typeof order.txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(order.txHash))) {
            throw new BawCliError("INVALID_OUTPUT", "market-order")
        }
        result.txHash = order.txHash as string | null
    }
    if (order.refund !== undefined) {
        if (!Array.isArray(order.refund)) throw new BawCliError("INVALID_OUTPUT", "market-order")
        result.refund = order.refund.map((refund) => {
            if (!isRecord(refund)) throw new BawCliError("INVALID_OUTPUT", "market-order")
            const tokenAddress = boundedString(refund.tokenAddress, 64)
            const amount = validQuoteAmount(refund.amount)
            const symbol = validCoinSymbol(refund.symbol)
            if (!tokenAddress || !EVM_ADDRESS_PATTERN.test(tokenAddress) || !amount || !symbol) {
                throw new BawCliError("INVALID_OUTPUT", "market-order")
            }
            return { tokenAddress, amount, symbol }
        })
    }
    return result
}

export function parseBawMarketOrderHistoryOutput(stdout: string): {
    orderId: string
    chain: string
    fromToken: string
    fromTokenQty: string
    toToken: string
    status: "PENDING" | "FINISHED" | "FAILED"
    bookTime: string
}[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout)
    } catch {
        throw new BawCliError("INVALID_OUTPUT", "market-order")
    }
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["success", "data"]) || parsed.success !== true ||
        !isRecord(parsed.data) || !Array.isArray(parsed.data.list)) {
        throw new BawCliError("INVALID_OUTPUT", "market-order")
    }
    return parsed.data.list.map((value) => {
        if (
            !isRecord(value) ||
            value.orderType !== "market" ||
            typeof value.orderId !== "string" ||
            !BAW_ORDER_ID_PATTERN.test(value.orderId) ||
            value.chain !== "56" ||
            typeof value.fromToken !== "string" ||
            !EVM_ADDRESS_PATTERN.test(value.fromToken) ||
            typeof value.toToken !== "string" ||
            !EVM_ADDRESS_PATTERN.test(value.toToken) ||
            typeof value.fromTokenQty !== "string" ||
            !isPositiveBawAmount(value.fromTokenQty) ||
            (value.status !== "PENDING" && value.status !== "FINISHED" && value.status !== "FAILED") ||
            typeof value.bookTime !== "string" ||
            !Number.isFinite(Date.parse(value.bookTime))
        ) throw new BawCliError("INVALID_OUTPUT", "market-order")
        return {
            orderId: value.orderId,
            chain: "56",
            fromToken: value.fromToken,
            fromTokenQty: value.fromTokenQty,
            toToken: value.toToken,
            status: value.status,
            bookTime: value.bookTime,
        }
    })
}

function quoteAmountUnits(value: string): string | null {
    if (!isPositiveBawAmount(value)) return null
    const [whole, fraction = ""] = value.split(".")
    return BigInt(`${whole}${fraction.padEnd(18, "0")}`).toString()
}

function validQuoteAmount(value: unknown): string | null {
    return typeof value === "string" && isPositiveBawAmount(value) ? value : null
}

function validCoinSymbol(value: unknown): string | null {
    return typeof value === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : null
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(record)
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key))
}

export type BawCliErrorCode =
    | "BAW_UNAVAILABLE"
    | "BAW_TIMEOUT"
    | "BAW_RATE_LIMITED"
    | "BAW_COMMAND_FAILED"
    | "BAW_COMMAND_NOT_ALLOWED"
    | "INVALID_OUTPUT"

export class BawCliError extends Error {
    readonly code: BawCliErrorCode
    readonly section: string

    constructor(code: BawCliErrorCode, section: string) {
        super(`Binance Agentic Wallet read failed: ${code} (${section})`)
        this.name = "BawCliError"
        this.code = code
        this.section = section
    }
}

export type BawRunner = (args: readonly string[]) => Promise<{ stdout: string }>

export type BawQuoteDirection = "BUY" | "SELL"

export type BawQuoteCommandInput = {
    direction: BawQuoteDirection
    tokenAddress: string
    amount: string
    chainId: string
    slippagePercent: string
}

export type BawQuoteOutput = {
    fromCoinSymbol: string
    fromCoinAmount: string
    toCoinSymbol: string
    toCoinAmount: string
    slippage: number
}

export type BawChain = {
    binanceChainId: string
    name: string
    simpleName: string
}

export type BawAddress = {
    binanceChainId: string
    chainName: string
    address: string
}

export type BawBalance = {
    symbol: string
    contractAddress: string
    binanceChainId: string
    balance: string
    priceUsd: string
    valueUsd: string
}

export type BawSafeSettings = {
    dailyLimit: number
    quotaUsed: number
    quotaLeft: number
    abnormalTxnHandling: string
    tradeAllTokens: boolean
    predictionEnabled: boolean
    sessionExpireTime: string
}

export type BawWalletSnapshot = {
    connected: boolean
    fetchedAt: string
    chains: BawChain[]
    addresses: BawAddress[]
    balances: BawBalance[]
    settings: BawSafeSettings | null
    errors: { section: string; code: BawCliErrorCode }[]
}

export function buildBawMarketQuoteArgs(input: BawQuoteCommandInput): readonly string[] {
    if (input.direction !== "BUY" && input.direction !== "SELL") {
        throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "quote")
    }
    if (input.chainId !== "56" || !EVM_ADDRESS_PATTERN.test(input.tokenAddress)) {
        throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "quote")
    }
    const token = input.tokenAddress.toLowerCase()
    if (token === BSC_USDT_ADDRESS.toLowerCase() || !isPositiveBawAmount(input.amount)) {
        throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "quote")
    }
    if (!BAW_QUOTE_SLIPPAGE_PATTERN.test(input.slippagePercent)) {
        throw new BawCliError("BAW_COMMAND_NOT_ALLOWED", "quote")
    }

    const fromToken = input.direction === "BUY" ? BSC_USDT_ADDRESS : input.tokenAddress
    const toToken = input.direction === "BUY" ? input.tokenAddress : BSC_USDT_ADDRESS
    return [
        "market-order", "quote",
        "--fromTokenQty", input.amount,
        "--fromToken", fromToken,
        "--toToken", toToken,
        "--binanceChainId", input.chainId,
        "--slippage", input.slippagePercent,
        "--json",
    ]
}

export function parseBawMarketQuoteArgs(args: readonly string[]): BawQuoteCommandInput | null {
    if (
        args.length !== 13 ||
        args[0] !== "market-order" ||
        args[1] !== "quote" ||
        args[2] !== "--fromTokenQty" ||
        args[4] !== "--fromToken" ||
        args[6] !== "--toToken" ||
        args[8] !== "--binanceChainId" ||
        args[10] !== "--slippage" ||
        args[12] !== "--json"
    ) return null

    const amount = args[3]
    const fromToken = args[5]
    const toToken = args[7]
    const chainId = args[9]
    const slippagePercent = args[11]
    if (
        chainId !== "56" ||
        !EVM_ADDRESS_PATTERN.test(fromToken) ||
        !EVM_ADDRESS_PATTERN.test(toToken) ||
        fromToken.toLowerCase() === toToken.toLowerCase() ||
        !isPositiveBawAmount(amount) ||
        !BAW_QUOTE_SLIPPAGE_PATTERN.test(slippagePercent)
    ) return null

    const fromIsUsdt = fromToken.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase()
    const toIsUsdt = toToken.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase()
    if (fromIsUsdt === toIsUsdt) return null

    return {
        direction: fromIsUsdt ? "BUY" : "SELL",
        tokenAddress: fromIsUsdt ? toToken : fromToken,
        amount,
        chainId,
        slippagePercent,
    }
}

export function parseBawMarketQuoteOutput(
    stdout: string,
    expected: { direction: BawQuoteDirection; amount: string; slippagePercent: string; tokenSymbol: string }
): BawQuoteOutput {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout)
    } catch {
        throw new BawCliError("INVALID_OUTPUT", "quote")
    }
    if (!isRecord(parsed)) throw new BawCliError("INVALID_OUTPUT", "quote")
    if (
        parsed.success !== true &&
        (parsed.code === 42900 || /42900|rate.?limit/i.test(String(parsed.msg ?? parsed.message ?? "")))
    ) {
        throw new BawCliError("BAW_RATE_LIMITED", "quote")
    }
    if (
        !hasExactKeys(parsed, ["success", "data"]) ||
        parsed.success !== true ||
        !isRecord(parsed.data) ||
        !hasExactKeys(parsed.data, ["fromCoinSymbol", "fromCoinAmount", "toCoinSymbol", "toCoinAmount", "slippage"])
    ) {
        throw new BawCliError("INVALID_OUTPUT", "quote")
    }

    const data = parsed.data
    const fromCoinSymbol = validCoinSymbol(data.fromCoinSymbol)
    const toCoinSymbol = validCoinSymbol(data.toCoinSymbol)
    const fromCoinAmount = validQuoteAmount(data.fromCoinAmount)
    const toCoinAmount = validQuoteAmount(data.toCoinAmount)
    const expectedFromSymbol = expected.direction === "BUY" ? "USDT" : expected.tokenSymbol
    const expectedToSymbol = expected.direction === "BUY" ? expected.tokenSymbol : "USDT"
    const expectedSlippage = Number(expected.slippagePercent) / 100
    const slippage = data.slippage
    if (
        !fromCoinSymbol ||
        !toCoinSymbol ||
        !fromCoinAmount ||
        !toCoinAmount ||
        fromCoinSymbol.toUpperCase() !== expectedFromSymbol.toUpperCase() ||
        toCoinSymbol.toUpperCase() !== expectedToSymbol.toUpperCase() ||
        quoteAmountUnits(fromCoinAmount) !== quoteAmountUnits(expected.amount) ||
        typeof slippage !== "number" ||
        !Number.isFinite(slippage) ||
        Math.abs(slippage - expectedSlippage) > 1e-12
    ) {
        throw new BawCliError("INVALID_OUTPUT", "quote")
    }

    return { fromCoinSymbol, fromCoinAmount, toCoinSymbol, toCoinAmount, slippage }
}

export function createBawRunner(
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS
): BawRunner {
    const binary = env.BAW_BIN?.trim() || "baw"
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive safe integer")
    }
    return args => new Promise((resolve, reject) => {
        const command: BawExecutableCommand | undefined = (Object.entries(COMMAND_ARGS) as [BawCommand, readonly string[]][])
            .find(([, allowedArgs]) =>
                allowedArgs.length === args.length
                && allowedArgs.every((allowedArg, index) => allowedArg === args[index])
            )?.[0]
            ?? (parseBawMarketQuoteArgs(args) ? "market-order quote" : undefined)
            ?? (parseBawMarketSwapArgs(args) ? "market-order swap" : undefined)
            ?? (parseBawMarketOrderListArgs(args) ? "market-order list" : undefined)
            ?? (isBawMarketOrderReconciliationArgs(args) ? "market-order list" : undefined)
        if (!command) {
            return reject(new BawCliError("BAW_COMMAND_NOT_ALLOWED", "command"))
        }

        execFile(
            binary,
            [...args],
            { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
            (error, stdout) => {
                if (error) {
                    const code = (error as NodeJS.ErrnoException).code
                    const section = command.startsWith("market-order") ? "market-order" : command.split(" ")[1]
                    if (code === "ENOENT") return reject(new BawCliError("BAW_UNAVAILABLE", section))
                    if ((error as { killed?: boolean }).killed || code === "ETIMEDOUT") {
                        return reject(new BawCliError("BAW_TIMEOUT", section))
                    }
                    return reject(new BawCliError("BAW_COMMAND_FAILED", section))
                }
                if (typeof stdout !== "string" || stdout.length > MAX_OUTPUT_BYTES) {
                    return reject(new BawCliError("INVALID_OUTPUT", command.startsWith("market-order") ? "market-order" : command.split(" ")[1]))
                }
                resolve({ stdout })
            }
        )
    })
}

let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task)
    queue = next.then(() => undefined, () => undefined)
    return next
}

async function runJson(
    runner: BawRunner,
    command: BawCommand,
    section: string
): Promise<unknown> {
    let stdout: string
    try {
        ({ stdout } = await serialize(() => runner(COMMAND_ARGS[command])))
    } catch (error) {
        if (error instanceof BawCliError) {
            throw new BawCliError(error.code, section)
        }
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new BawCliError("BAW_UNAVAILABLE", section)
        }
        throw new BawCliError("BAW_COMMAND_FAILED", section)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(stdout)
    } catch {
        throw new BawCliError("INVALID_OUTPUT", section)
    }
    if (!isRecord(parsed) || parsed.success !== true) {
        throw new BawCliError("BAW_COMMAND_FAILED", section)
    }
    return parsed.data
}

export async function readWalletSnapshot(
    dependencies: { runner?: BawRunner; now?: () => number } = {}
): Promise<BawWalletSnapshot> {
    const runner = dependencies.runner ?? createBawRunner()
    const now = dependencies.now ?? Date.now
    const snapshot: BawWalletSnapshot = {
        connected: false,
        fetchedAt: new Date(now()).toISOString(),
        chains: [],
        addresses: [],
        balances: [],
        settings: null,
        errors: []
    }

    const status = parseWalletStatus(await runJson(runner, "wallet status", "status"))
    snapshot.connected = status === "CONNECTED"
    if (!snapshot.connected) return snapshot

    await readSection(snapshot, "chains", async () => {
        snapshot.chains = parseChains(await runJson(runner, "wallet chains", "chains"))
    })
    await readSection(snapshot, "addresses", async () => {
        snapshot.addresses = parseAddresses(await runJson(runner, "wallet address", "addresses"))
    })
    await readSection(snapshot, "balances", async () => {
        snapshot.balances = parseBalances(await runJson(runner, "wallet balance", "balances"))
    })
    await readSection(snapshot, "settings", async () => {
        snapshot.settings = parseSettings(await runJson(runner, "wallet settings", "settings"))
    })

    return snapshot
}

async function readSection(
    snapshot: BawWalletSnapshot,
    section: string,
    read: () => Promise<void>
) {
    try {
        await read()
    } catch (error) {
        const code = error instanceof BawCliError ? error.code : "INVALID_OUTPUT"
        snapshot.errors.push({ section, code })
    }
}

export function parseWalletStatus(data: unknown): "CONNECTED" | "UNCONNECTED" | "CREATING" {
    if (!isRecord(data)) throw new BawCliError("INVALID_OUTPUT", "status")
    if (data.status === "CONNECTED" || data.status === "UNCONNECTED" || data.status === "CREATING") {
        return data.status
    }
    throw new BawCliError("INVALID_OUTPUT", "status")
}

export function parseChains(data: unknown): BawChain[] {
    if (!Array.isArray(data)) throw new BawCliError("INVALID_OUTPUT", "chains")
    return data.map(value => {
        if (!isRecord(value)) throw new BawCliError("INVALID_OUTPUT", "chains")
        const binanceChainId = boundedString(value.binanceChainId, 16)
        const name = boundedString(value.name, 64)
        const simpleName = boundedString(value.simpleName, 64)
        if (!binanceChainId || !/^(?:\d{1,16}|CT_501)$/.test(binanceChainId) || !name || !simpleName) {
            throw new BawCliError("INVALID_OUTPUT", "chains")
        }
        return { binanceChainId, name, simpleName }
    })
}

export function parseAddresses(data: unknown): BawAddress[] {
    if (!isRecord(data) || !Array.isArray(data.addresses)) {
        throw new BawCliError("INVALID_OUTPUT", "addresses")
    }
    return data.addresses.map(value => {
        if (!isRecord(value)) throw new BawCliError("INVALID_OUTPUT", "addresses")
        const binanceChainId = boundedString(value.binanceChainId, 16)
        const chainName = boundedString(value.chainName, 64)
        const address = boundedString(value.address, 64)
        if (!binanceChainId || !chainName || !address || !isWalletAddress(binanceChainId, address)) {
            throw new BawCliError("INVALID_OUTPUT", "addresses")
        }
        return { binanceChainId, chainName, address }
    })
}

export function parseBalances(data: unknown): BawBalance[] {
    if (!Array.isArray(data)) throw new BawCliError("INVALID_OUTPUT", "balances")
    return data.map(value => {
        if (!isRecord(value)) throw new BawCliError("INVALID_OUTPUT", "balances")
        const symbol = boundedString(value.symbol, 32)
        const contractAddress = boundedString(value.address, 64)
        const binanceChainId = boundedString(value.binanceChainId, 16)
        const balance = decimalString(value.balance)
        const priceUsd = decimalString(value.price)
        const valueUsd = decimalString(value.value)
        if (!symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)
            || !contractAddress || !binanceChainId
            || !isWalletAddress(binanceChainId, contractAddress) || balance === null
            || priceUsd === null || valueUsd === null) {
            throw new BawCliError("INVALID_OUTPUT", "balances")
        }
        return { symbol, contractAddress, binanceChainId, balance, priceUsd, valueUsd }
    })
}

export function parseSettings(data: unknown): BawSafeSettings {
    if (!isRecord(data)) throw new BawCliError("INVALID_OUTPUT", "settings")
    const abnormalTxnHandling = boundedString(data.abnormalTxnHandling, 32)
    const sessionExpireTime = boundedString(data.sessionExpireTime, 64)
    if (
        (abnormalTxnHandling !== "AutoReject" && abnormalTxnHandling !== "NeedConfirmation")
        || typeof data.tradeAllTokens !== "boolean"
        || typeof data.predictionEnabled !== "boolean"
        || !sessionExpireTime
        || !Number.isFinite(Date.parse(sessionExpireTime))
    ) {
        throw new BawCliError("INVALID_OUTPUT", "settings")
    }

    return {
        dailyLimit: requiredFiniteNumber(data.dailyLimit, "settings"),
        quotaUsed: requiredFiniteNumber(data.quotaUsed, "settings"),
        quotaLeft: requiredFiniteNumber(data.quotaLeft, "settings"),
        abnormalTxnHandling,
        tradeAllTokens: data.tradeAllTokens,
        predictionEnabled: data.predictionEnabled,
        sessionExpireTime
    }
}

function isWalletAddress(binanceChainId: string, address: string): boolean {
    if (binanceChainId === "CT_501") return SOLANA_ADDRESS_PATTERN.test(address)
    if (/^\d+$/.test(binanceChainId)) return EVM_ADDRESS_PATTERN.test(address)
    return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength
        && !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : null
}

function decimalString(value: unknown): string | null {
    const text = typeof value === "number" ? String(value) : value
    return typeof text === "string" && text.length <= 80 && DECIMAL_PATTERN.test(text)
        ? text
        : null
}

function requiredFiniteNumber(value: unknown, section: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new BawCliError("INVALID_OUTPUT", section)
    }
    return value
}
