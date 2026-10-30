import { execFile } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 1_000_000
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

type BawCommand =
    | "wallet status"
    | "wallet address"
    | "wallet chains"
    | "wallet balance"
    | "wallet settings"

const COMMAND_ARGS: Record<BawCommand, readonly string[]> = {
    "wallet status": ["wallet", "status", "--json"],
    "wallet address": ["wallet", "address", "--json"],
    "wallet chains": ["wallet", "chains", "--json"],
    "wallet balance": ["wallet", "balance", "--json"],
    "wallet settings": ["wallet", "settings", "--json"]
}

export type BawCliErrorCode =
    | "BAW_UNAVAILABLE"
    | "BAW_TIMEOUT"
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

export function createBawRunner(
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS
): BawRunner {
    const binary = env.BAW_BIN?.trim() || "baw"
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive safe integer")
    }
    return args => new Promise((resolve, reject) => {
        const command = (Object.entries(COMMAND_ARGS) as [BawCommand, readonly string[]][])
            .find(([, allowedArgs]) =>
                allowedArgs.length === args.length
                && allowedArgs.every((allowedArg, index) => allowedArg === args[index])
            )?.[0]
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
                    const section = command.split(" ")[1]
                    if (code === "ENOENT") return reject(new BawCliError("BAW_UNAVAILABLE", section))
                    if ((error as { killed?: boolean }).killed || code === "ETIMEDOUT") {
                        return reject(new BawCliError("BAW_TIMEOUT", section))
                    }
                    return reject(new BawCliError("BAW_COMMAND_FAILED", section))
                }
                if (typeof stdout !== "string" || stdout.length > MAX_OUTPUT_BYTES) {
                    return reject(new BawCliError("INVALID_OUTPUT", command.split(" ")[1]))
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
    if (
        (abnormalTxnHandling !== "AutoReject" && abnormalTxnHandling !== "NeedConfirmation")
        || typeof data.tradeAllTokens !== "boolean"
        || typeof data.predictionEnabled !== "boolean"
    ) {
        throw new BawCliError("INVALID_OUTPUT", "settings")
    }

    return {
        dailyLimit: requiredFiniteNumber(data.dailyLimit, "settings"),
        quotaUsed: requiredFiniteNumber(data.quotaUsed, "settings"),
        quotaLeft: requiredFiniteNumber(data.quotaLeft, "settings"),
        abnormalTxnHandling,
        tradeAllTokens: data.tradeAllTokens,
        predictionEnabled: data.predictionEnabled
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
