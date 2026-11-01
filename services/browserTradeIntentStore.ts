import { createHash, timingSafeEqual } from "node:crypto"
import postgres, { type Sql } from "postgres"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isValidBinanceQuoteId } from "../lib/apiValidation.ts"

export const BROWSER_TRADE_STATES = [
    "CREATED",
    "PREPARED",
    "SUBMISSION_PENDING",
    "SUBMITTED",
    "UNKNOWN",
    "CONFIRMED",
    "OUTPUT_VERIFIED",
    "OUTPUT_MISMATCH",
    "REJECTED",
    "EXPIRED",
    "REVERTED",
] as const

export type BrowserTradeState = typeof BROWSER_TRADE_STATES[number]

export type BrowserTradeIntent = {
    executionId: string
    quoteBindingHash: string
    quoteId: string
    walletAddress: string
    chainId: 56
    direction: "BUY"
    inputTokenAddress: string
    outputTokenAddress: string
    inputAmount: string
    expectedOutputAmount: string
    minimumOutputAmount: string
    slippageBps: number
    quoteFetchedAt: number
    expiresAt: number
    state: BrowserTradeState
    idempotencyKey: string | null
    transactionHash: string | null
    providerOrderId: string | null
    failureCode: string | null
    createdAt: number
    updatedAt: number
}

export interface BrowserTradeIntentStorePort {
    close(): Promise<void>
    initialize(): Promise<void>
    create(intent: BrowserTradeIntent): Promise<void>
    get(executionId: string): Promise<BrowserTradeIntent | null>
    prepare(executionId: string, walletAddress: string, now: number): Promise<BrowserTradeIntent>
    reject(executionId: string, failureCode: string, now: number): Promise<BrowserTradeIntent>
    claimSubmission(executionId: string, idempotencyKey: string, now: number): Promise<BrowserTradeIntent>
    updateSubmission(
        executionId: string,
        state: "SUBMITTED" | "UNKNOWN" | "CONFIRMED" | "OUTPUT_VERIFIED" | "OUTPUT_MISMATCH" | "REVERTED",
        values: { transactionHash?: string; providerOrderId?: string; failureCode?: string },
        now: number,
    ): Promise<BrowserTradeIntent>
}

const MIGRATIONS = [{
    version: 1,
    statements: [
        `CREATE TABLE wolv_trade_intents (
            execution_id uuid PRIMARY KEY,
            quote_binding_hash char(64) NOT NULL UNIQUE,
            quote_id text NOT NULL,
            wallet_address text NOT NULL,
            chain_id integer NOT NULL CHECK (chain_id = 56),
            direction text NOT NULL CHECK (direction = 'BUY'),
            input_token_address text NOT NULL,
            output_token_address text NOT NULL,
            input_amount numeric NOT NULL CHECK (input_amount > 0),
            expected_output_amount numeric NOT NULL CHECK (expected_output_amount > 0),
            minimum_output_amount numeric NOT NULL CHECK (minimum_output_amount > 0),
            slippage_bps integer NOT NULL CHECK (slippage_bps BETWEEN 1 AND 500),
            quote_fetched_at bigint NOT NULL,
            expires_at bigint NOT NULL,
            execution_status text NOT NULL CHECK (execution_status IN (${BROWSER_TRADE_STATES.map((state) => `'${state}'`).join(",")})),
            idempotency_key uuid UNIQUE,
            transaction_hash char(66) UNIQUE,
            provider_order_id text,
            failure_code text,
            created_at bigint NOT NULL,
            updated_at bigint NOT NULL
        )`,
        "CREATE INDEX wolv_trade_intents_wallet_created ON wolv_trade_intents (wallet_address, created_at DESC)",
        "CREATE INDEX wolv_trade_intents_status_expiry ON wolv_trade_intents (execution_status, expires_at)",
    ],
}]
const MIGRATION_LOCK_ID = 7_891_230_457
const TERMINAL_STATES: readonly BrowserTradeState[] = ["OUTPUT_VERIFIED", "OUTPUT_MISMATCH", "REJECTED", "EXPIRED", "REVERTED"]

export class BrowserTradeIntentStoreError extends Error {
    code: "NOT_CONFIGURED" | "INVALID_DATABASE_URL" | "NOT_FOUND" | "EXPIRED" | "CONSUMED" | "INVALID_TRANSITION"

    constructor(code: "NOT_CONFIGURED" | "INVALID_DATABASE_URL" | "NOT_FOUND" | "EXPIRED" | "CONSUMED" | "INVALID_TRANSITION") {
        super(`Browser trade intent store unavailable: ${code}`)
        this.name = "BrowserTradeIntentStoreError"
        this.code = code
    }
}

export class BrowserTradeIntentStore implements BrowserTradeIntentStorePort {
    private readonly sql: Sql
    private readonly ready: Promise<void>

    constructor(databaseUrl = process.env.WOLV_TRADING_DATABASE_URL) {
        if (!databaseUrl) throw new BrowserTradeIntentStoreError("NOT_CONFIGURED")
        if (!isSafePostgresUrl(databaseUrl)) throw new BrowserTradeIntentStoreError("INVALID_DATABASE_URL")
        this.sql = postgres(databaseUrl, {
            max: 1,
            idle_timeout: 20,
            connect_timeout: 5,
            max_lifetime: 300,
            prepare: false,
            ssl: isLocalDevelopmentUrl(databaseUrl) ? false : "verify-full",
        })
        this.ready = this.runMigrations()
    }

    async close(): Promise<void> {
        await this.sql.end({ timeout: 5 })
    }

    async initialize(): Promise<void> {
        await this.ready
    }

    async create(intent: BrowserTradeIntent): Promise<void> {
        await this.ready
        if (
            intent.state !== "CREATED" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.executionId) ||
            !/^[0-9a-f]{64}$/.test(intent.quoteBindingHash) ||
            !isValidBinanceQuoteId(intent.quoteId) ||
            !EVM_ADDRESS_PATTERN.test(intent.walletAddress) ||
            intent.chainId !== 56 ||
            intent.direction !== "BUY" ||
            intent.inputTokenAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase() ||
            !EVM_ADDRESS_PATTERN.test(intent.outputTokenAddress) ||
            intent.outputTokenAddress.toLowerCase() === intent.inputTokenAddress.toLowerCase() ||
            !/^(?:0|[1-9]\d*)$/.test(intent.inputAmount) ||
            !/^(?:0|[1-9]\d*)$/.test(intent.expectedOutputAmount) ||
            !/^(?:0|[1-9]\d*)$/.test(intent.minimumOutputAmount) ||
            BigInt(intent.minimumOutputAmount) > BigInt(intent.expectedOutputAmount) ||
            !Number.isSafeInteger(intent.slippageBps) ||
            intent.slippageBps < 1 ||
            intent.slippageBps > 500 ||
            !Number.isSafeInteger(intent.quoteFetchedAt) ||
            !Number.isSafeInteger(intent.expiresAt) ||
            intent.expiresAt <= intent.quoteFetchedAt
        ) throw new BrowserTradeIntentStoreError("INVALID_TRANSITION")
        await this.sql`
            INSERT INTO wolv_trade_intents (
                execution_id, quote_binding_hash, quote_id, wallet_address, chain_id, direction,
                input_token_address, output_token_address, input_amount, expected_output_amount,
                minimum_output_amount, slippage_bps, quote_fetched_at, expires_at, execution_status,
                idempotency_key, transaction_hash, provider_order_id, failure_code, created_at, updated_at
            ) VALUES (
                ${intent.executionId}, ${intent.quoteBindingHash}, ${intent.quoteId}, ${intent.walletAddress},
                ${intent.chainId}, ${intent.direction}, ${intent.inputTokenAddress}, ${intent.outputTokenAddress},
                ${intent.inputAmount}, ${intent.expectedOutputAmount}, ${intent.minimumOutputAmount},
                ${intent.slippageBps}, ${intent.quoteFetchedAt}, ${intent.expiresAt}, ${intent.state},
                ${intent.idempotencyKey}, ${intent.transactionHash}, ${intent.providerOrderId},
                ${intent.failureCode}, ${intent.createdAt}, ${intent.updatedAt}
            )
        `
    }

    async get(executionId: string): Promise<BrowserTradeIntent | null> {
        await this.ready
        const rows = await this.sql`
            SELECT * FROM wolv_trade_intents WHERE execution_id = ${executionId}
        `
        return rows[0] ? parseIntent(rows[0]) : null
    }

    async prepare(executionId: string, walletAddress: string, now: number): Promise<BrowserTradeIntent> {
        await this.ready
        const outcome = await this.sql.begin(async (transaction) => {
            const rows = await transaction`
                SELECT * FROM wolv_trade_intents WHERE execution_id = ${executionId} FOR UPDATE
            `
            const row = rows[0]
            if (!row) throw new BrowserTradeIntentStoreError("NOT_FOUND")
            const intent = parseIntent(row)
            if (!safeAddressMatch(intent.walletAddress, walletAddress)) throw new BrowserTradeIntentStoreError("NOT_FOUND")
            if (intent.expiresAt <= now) {
                if (intent.state === "CREATED") {
                    await transaction`
                        UPDATE wolv_trade_intents SET execution_status = 'EXPIRED', updated_at = ${now}
                        WHERE execution_id = ${executionId} AND execution_status = 'CREATED'
                    `
                }
                return { error: "EXPIRED" as const }
            }
            if (intent.state !== "CREATED") return { error: "CONSUMED" as const }
            const updated = await transaction`
                UPDATE wolv_trade_intents
                SET execution_status = 'PREPARED', updated_at = ${now}
                WHERE execution_id = ${executionId} AND execution_status = 'CREATED' AND expires_at > ${now}
                RETURNING *
            `
            if (updated.length !== 1) return { error: "CONSUMED" as const }
            return { intent: parseIntent(updated[0]) }
        })
        if ("error" in outcome) {
            const errorCode = outcome.error ?? "INVALID_TRANSITION"
            throw new BrowserTradeIntentStoreError(errorCode)
        }
        return outcome.intent
    }

    async reject(executionId: string, failureCode: string, now: number): Promise<BrowserTradeIntent> {
        return this.transition(executionId, ["PREPARED"], "REJECTED", { failureCode }, now)
    }

    async claimSubmission(executionId: string, idempotencyKey: string, now: number): Promise<BrowserTradeIntent> {
        await this.ready
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
            throw new BrowserTradeIntentStoreError("INVALID_TRANSITION")
        }
        const outcome = await this.sql.begin(async (transaction) => {
            const rows = await transaction`
                SELECT * FROM wolv_trade_intents WHERE execution_id = ${executionId} FOR UPDATE
            `
            if (!rows[0]) throw new BrowserTradeIntentStoreError("NOT_FOUND")
            const intent = parseIntent(rows[0])
            if (intent.expiresAt <= now && intent.state === "PREPARED") {
                await transaction`
                    UPDATE wolv_trade_intents SET execution_status = 'EXPIRED', updated_at = ${now}
                    WHERE execution_id = ${executionId} AND execution_status = 'PREPARED'
                `
                return { error: "EXPIRED" as const }
            }
            if (
                intent.idempotencyKey === idempotencyKey &&
                ["SUBMISSION_PENDING", "SUBMITTED", "UNKNOWN", "CONFIRMED", "OUTPUT_VERIFIED", "OUTPUT_MISMATCH", "REVERTED"].includes(intent.state)
            ) return { intent }
            if (intent.state !== "PREPARED" || intent.idempotencyKey !== null) {
                return { error: "CONSUMED" as const }
            }
            const updated = await transaction`
                UPDATE wolv_trade_intents
                SET execution_status = 'SUBMISSION_PENDING', idempotency_key = ${idempotencyKey}, updated_at = ${now}
                WHERE execution_id = ${executionId} AND execution_status = 'PREPARED' AND idempotency_key IS NULL
                RETURNING *
            `
            if (updated.length !== 1) return { error: "CONSUMED" as const }
            return { intent: parseIntent(updated[0]) }
        })
        if ("error" in outcome) {
            const errorCode = outcome.error ?? "INVALID_TRANSITION"
            throw new BrowserTradeIntentStoreError(errorCode)
        }
        return outcome.intent
    }

    async updateSubmission(
        executionId: string,
        state: "SUBMITTED" | "UNKNOWN" | "CONFIRMED" | "OUTPUT_VERIFIED" | "OUTPUT_MISMATCH" | "REVERTED",
        values: { transactionHash?: string; providerOrderId?: string; failureCode?: string },
        now: number,
    ): Promise<BrowserTradeIntent> {
        const allowedFrom: Record<typeof state, readonly BrowserTradeState[]> = {
            SUBMITTED: ["SUBMISSION_PENDING", "SUBMITTED", "UNKNOWN"],
            UNKNOWN: ["SUBMISSION_PENDING", "SUBMITTED", "UNKNOWN"],
            CONFIRMED: ["SUBMITTED", "UNKNOWN", "CONFIRMED"],
            OUTPUT_VERIFIED: ["CONFIRMED"],
            OUTPUT_MISMATCH: ["CONFIRMED"],
            REVERTED: ["CONFIRMED"],
        }
        if (
            (state === "SUBMITTED" && !values.transactionHash && !values.providerOrderId) ||
            (["CONFIRMED", "OUTPUT_VERIFIED", "OUTPUT_MISMATCH", "REVERTED"].includes(state) && !values.transactionHash) ||
            (values.transactionHash !== undefined && !/^0x[a-fA-F0-9]{64}$/.test(values.transactionHash)) ||
            (values.providerOrderId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(values.providerOrderId)) ||
            (values.failureCode !== undefined && !/^[A-Z0-9_]{1,64}$/.test(values.failureCode))
        ) throw new BrowserTradeIntentStoreError("INVALID_TRANSITION")
        return this.transition(
            executionId,
            allowedFrom[state],
            state,
            values,
            now,
        )
    }

    private async transition(
        executionId: string,
        allowedFrom: readonly BrowserTradeState[],
        state: BrowserTradeState,
        values: { transactionHash?: string; providerOrderId?: string; failureCode?: string },
        now: number,
    ): Promise<BrowserTradeIntent> {
        await this.ready
        const rows = await this.sql`
            UPDATE wolv_trade_intents
            SET execution_status = ${state},
                transaction_hash = COALESCE(${values.transactionHash ?? null}, transaction_hash),
                provider_order_id = COALESCE(${values.providerOrderId ?? null}, provider_order_id),
                failure_code = ${values.failureCode ?? null},
                updated_at = ${now}
            WHERE execution_id = ${executionId} AND execution_status = ANY(${this.sql.array([...allowedFrom])})
            RETURNING *
        `
        if (rows.length !== 1) {
            const current = await this.get(executionId)
            if (!current) throw new BrowserTradeIntentStoreError("NOT_FOUND")
            throw new BrowserTradeIntentStoreError(TERMINAL_STATES.includes(current.state) ? "INVALID_TRANSITION" : "CONSUMED")
        }
        return parseIntent(rows[0])
    }

    private async runMigrations(): Promise<void> {
        await this.sql.begin(async (transaction) => {
            await transaction`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`
            await transaction`
                CREATE TABLE IF NOT EXISTS wolv_trading_schema_migrations (
                    version integer PRIMARY KEY,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
            `
            for (const migration of MIGRATIONS) {
                const applied = await transaction`
                    SELECT version FROM wolv_trading_schema_migrations WHERE version = ${migration.version}
                `
                if (applied.length) continue
                for (const statement of migration.statements) await transaction.unsafe(statement)
                await transaction`
                    INSERT INTO wolv_trading_schema_migrations (version) VALUES (${migration.version})
                `
            }
        })
    }
}

let defaultStore: BrowserTradeIntentStore | null = null

export function getDefaultBrowserTradeIntentStore(): BrowserTradeIntentStore {
    if (!defaultStore) defaultStore = new BrowserTradeIntentStore()
    return defaultStore
}

export function hashQuoteBinding(binding: string): string {
    return createHash("sha256").update(binding, "utf8").digest("hex")
}

function isSafePostgresUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return ["postgres:", "postgresql:"].includes(url.protocol) &&
            url.hostname.length > 0 &&
            url.username.length > 0 &&
            url.password.length > 0 &&
            !["disable", "allow", "prefer"].includes(url.searchParams.get("sslmode") ?? "")
    } catch {
        return false
    }
}

function isLocalDevelopmentUrl(value: string): boolean {
    if (process.env.NODE_ENV === "production") return false
    try {
        return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname)
    } catch {
        return false
    }
}

function safeAddressMatch(left: string, right: string): boolean {
    return /^[0-9a-fA-F]{40}$/.test(left.replace(/^0x/, "")) &&
        /^[0-9a-fA-F]{40}$/.test(right.replace(/^0x/, "")) &&
        left.toLowerCase() === right.toLowerCase()
}

function parseIntent(row: Record<string, unknown>): BrowserTradeIntent {
    const state = row.execution_status
    if (!BROWSER_TRADE_STATES.includes(state as BrowserTradeState)) {
        throw new BrowserTradeIntentStoreError("INVALID_TRANSITION")
    }
    return {
        executionId: String(row.execution_id),
        quoteBindingHash: String(row.quote_binding_hash).trim(),
        quoteId: String(row.quote_id),
        walletAddress: String(row.wallet_address),
        chainId: 56,
        direction: "BUY",
        inputTokenAddress: String(row.input_token_address),
        outputTokenAddress: String(row.output_token_address),
        inputAmount: String(row.input_amount),
        expectedOutputAmount: String(row.expected_output_amount),
        minimumOutputAmount: String(row.minimum_output_amount),
        slippageBps: Number(row.slippage_bps),
        quoteFetchedAt: Number(row.quote_fetched_at),
        expiresAt: Number(row.expires_at),
        state: state as BrowserTradeState,
        idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
        transactionHash: row.transaction_hash == null ? null : String(row.transaction_hash).trim(),
        providerOrderId: row.provider_order_id == null ? null : String(row.provider_order_id),
        failureCode: row.failure_code == null ? null : String(row.failure_code),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    }
}
