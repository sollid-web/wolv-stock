import { timingSafeEqual } from "node:crypto"
import postgres, { type Sql } from "postgres"

export type BawExecutionState =
    | "APPROVAL_REQUIRED"
    | "APPROVED"
    | "SUBMITTING"
    | "SUBMITTED"
    | "PENDING"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "FAILED"
    | "CANCELLED"
    | "EXPIRED"
    | "UNKNOWN"

export type BawExecutionRecord = {
    executionId: string
    approvalReference: string
    quoteReference: string
    walletAddress: string
    tokenAddress: string
    underlyingTicker: string
    tokenSymbol: string
    fromCoinSymbol: string
    toCoinSymbol: string
    direction: "BUY" | "SELL"
    chainId: "56"
    fromTokenAddress: string
    toTokenAddress: string
    requestedInputAmount: string
    expectedOutputAmount: string
    minimumOutputAmount: string
    quoteBinding: string
    quoteFetchedAt: number
    referencePrice: number
    tokenPriceUsd: number
    referenceGapPercent: number | null
    slippageBps: number
    quoteExpiresAt: number
    notionalUsd: number
    state: BawExecutionState
    securityAuditAcknowledged: boolean
    providerOrderId: string | null
    actualExecutedInput: string | null
    actualReceivedOutput: string | null
    refunds: { tokenAddress: string; amount: string; symbol: string }[]
    averageExecutionPrice: string | null
    transactionHash: string | null
    failureReason: string | null
    submittedAt: number | null
    completedAt: number | null
}

export type BawWalletSessionRecord = { address: string; expiresAt: number }

export interface BawExecutionStorePort {
    close(): Promise<void>
    createApproval(record: BawExecutionRecord, tokenHash: string, expiresAt: number, createdAt?: number): Promise<void>
    consumeApproval(executionId: string, tokenHash: string, now: number): Promise<BawExecutionRecord>
    update(record: BawExecutionRecord): Promise<void>
    get(executionId: string): Promise<BawExecutionRecord | null>
    dailyNotionalSince(startOfDay: number, excludeExecutionId?: string): Promise<number>
    createChallenge(nonceHash: string, address: string, expiresAt: number, createdAt: number): Promise<void>
    consumeChallengeAndCreateSession(nonceHash: string, address: string, now: number, sessionId: string, expiresAt: number): Promise<boolean>
    getSession(sessionId: string, now: number): Promise<BawWalletSessionRecord | null>
    revokeSession(sessionId: string, now: number): Promise<void>
}

const ACTIVE_STATES = ["APPROVAL_REQUIRED", "APPROVED", "SUBMITTING", "SUBMITTED", "PENDING", "PARTIALLY_FILLED", "UNKNOWN"]
const MIGRATIONS = [{
    version: 1,
    statements: [
        `CREATE TABLE baw_executions (
            execution_id uuid PRIMARY KEY,
            token_hash text NOT NULL,
            token_used boolean NOT NULL DEFAULT false,
            approval_expires_at bigint NOT NULL,
            execution_status text NOT NULL,
            notional_usd numeric NOT NULL DEFAULT 0,
            created_at bigint NOT NULL,
            record_json jsonb NOT NULL
        )`,
        `CREATE UNIQUE INDEX baw_execution_single_flight
            ON baw_executions ((true))
            WHERE execution_status IN (${ACTIVE_STATES.map((state) => `'${state}'`).join(",")})`,
        "CREATE INDEX baw_execution_daily_limit ON baw_executions (created_at, execution_status)",
        `CREATE TABLE baw_auth_challenges (
            nonce_hash text PRIMARY KEY,
            address text NOT NULL,
            expires_at bigint NOT NULL,
            created_at bigint NOT NULL
        )`,
        `CREATE TABLE baw_auth_sessions (
            session_id uuid PRIMARY KEY,
            address text NOT NULL,
            expires_at bigint NOT NULL,
            revoked_at bigint
        )`,
        "CREATE INDEX baw_auth_challenges_expiration ON baw_auth_challenges (expires_at)",
        "CREATE INDEX baw_auth_sessions_expiration ON baw_auth_sessions (expires_at)",
    ],
}]
const MIGRATION_LOCK_ID = 7_891_230_456

export class BawExecutionStoreError extends Error {
    readonly code: "NOT_CONFIGURED" | "UNSAFE_PATH" | "DUPLICATE" | "NOT_FOUND" | "USED" | "EXPIRED" | "BUSY"

    constructor(code: BawExecutionStoreError["code"]) {
        super(`BAW execution store unavailable: ${code}`)
        this.name = "BawExecutionStoreError"
        this.code = code
    }
}

export class BawExecutionStore implements BawExecutionStorePort {
    private readonly postgres: Sql
    private readonly ready: Promise<void>

    constructor(databaseUrl = process.env.BAW_EXECUTION_DATABASE_URL) {
        if (!databaseUrl) throw new BawExecutionStoreError("NOT_CONFIGURED")
        if (!isPostgresUrl(databaseUrl)) throw new BawExecutionStoreError("UNSAFE_PATH")

        this.postgres = postgres(databaseUrl, {
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
        await this.postgres.end({ timeout: 5 })
    }

    async createApproval(record: BawExecutionRecord, tokenHash: string, expiresAt: number, createdAt = Date.now()): Promise<void> {
        await this.ready
        try {
            await this.postgres.begin(async (transaction) => {
                await transaction`
                    UPDATE baw_executions
                    SET execution_status = 'EXPIRED',
                        record_json = jsonb_set(record_json, '{state}', '"EXPIRED"'::jsonb)
                    WHERE execution_status = 'APPROVAL_REQUIRED' AND approval_expires_at <= ${createdAt}
                `
                await transaction`
                    INSERT INTO baw_executions
                        (execution_id, token_hash, approval_expires_at, execution_status, notional_usd, created_at, record_json)
                    VALUES (${record.executionId}, ${tokenHash}, ${expiresAt}, ${record.state}, 0, ${createdAt}, ${JSON.stringify(record)}::jsonb)
                `
            })
        } catch (error) {
            if (isPostgresConflict(error)) throw new BawExecutionStoreError("BUSY")
            throw error
        }
    }

    async consumeApproval(executionId: string, tokenHash: string, now: number): Promise<BawExecutionRecord> {
        await this.ready
        const outcome = await this.postgres.begin(async (transaction) => {
            const rows = await transaction`
                SELECT token_hash, token_used, approval_expires_at, execution_status, record_json
                FROM baw_executions WHERE execution_id = ${executionId} FOR UPDATE
            `
            const row = rows[0]
            if (!row) throw new BawExecutionStoreError("NOT_FOUND")
            if (
                row.token_used ||
                row.execution_status !== "APPROVAL_REQUIRED" ||
                !safeHashMatch(String(row.token_hash), tokenHash)
            ) throw new BawExecutionStoreError("USED")

            const record = parseRecord(row.record_json)
            if (now >= Number(row.approval_expires_at)) {
                record.state = "EXPIRED"
                await transaction`
                    UPDATE baw_executions
                    SET execution_status = 'EXPIRED', record_json = ${JSON.stringify(record)}::jsonb
                    WHERE execution_id = ${executionId} AND token_used = false AND execution_status = 'APPROVAL_REQUIRED'
                `
                return { expired: true as const }
            }

            record.state = "APPROVED"
            record.submittedAt = null
            const updated = await transaction`
                UPDATE baw_executions
                SET token_used = true, execution_status = 'APPROVED',
                    notional_usd = ${record.notionalUsd}, record_json = ${JSON.stringify(record)}::jsonb
                WHERE execution_id = ${executionId} AND token_used = false AND execution_status = 'APPROVAL_REQUIRED'
                RETURNING execution_id
            `
            if (updated.length !== 1) throw new BawExecutionStoreError("USED")
            return { record }
        })
        if ("expired" in outcome) throw new BawExecutionStoreError("EXPIRED")
        return outcome.record
    }

    async update(record: BawExecutionRecord): Promise<void> {
        await this.ready
        const updated = await this.postgres`
            UPDATE baw_executions
            SET execution_status = ${record.state}, record_json = ${JSON.stringify(record)}::jsonb
            WHERE execution_id = ${record.executionId}
            RETURNING execution_id
        `
        if (updated.length !== 1) throw new BawExecutionStoreError("NOT_FOUND")
    }

    async get(executionId: string): Promise<BawExecutionRecord | null> {
        await this.ready
        const rows = await this.postgres`
            SELECT record_json FROM baw_executions WHERE execution_id = ${executionId}
        `
        return rows[0] ? parseRecord(rows[0].record_json) : null
    }

    async dailyNotionalSince(startOfDay: number, excludeExecutionId?: string): Promise<number> {
        await this.ready
        const rows = await this.postgres`
            SELECT COALESCE(SUM(notional_usd), 0)::text AS total FROM baw_executions
            WHERE created_at >= ${startOfDay}
                AND execution_status NOT IN ('APPROVAL_REQUIRED', 'APPROVED', 'EXPIRED')
                AND (${excludeExecutionId ?? null}::uuid IS NULL OR execution_id <> ${excludeExecutionId ?? null}::uuid)
        `
        return Number(rows[0]?.total ?? 0)
    }

    async createChallenge(nonceHash: string, address: string, expiresAt: number, createdAt: number): Promise<void> {
        await this.ready
        await this.postgres`
            INSERT INTO baw_auth_challenges (nonce_hash, address, expires_at, created_at)
            VALUES (${nonceHash}, ${address}, ${expiresAt}, ${createdAt})
        `
    }

    async consumeChallengeAndCreateSession(
        nonceHash: string,
        address: string,
        now: number,
        sessionId: string,
        expiresAt: number,
    ): Promise<boolean> {
        await this.ready
        return this.postgres.begin(async (transaction) => {
            const consumed = await transaction`
                DELETE FROM baw_auth_challenges
                WHERE nonce_hash = ${nonceHash} AND address = ${address} AND expires_at > ${now}
                RETURNING nonce_hash
            `
            if (consumed.length !== 1) return false
            await transaction`
                INSERT INTO baw_auth_sessions (session_id, address, expires_at, revoked_at)
                VALUES (${sessionId}, ${address}, ${expiresAt}, NULL)
            `
            return true
        })
    }

    async getSession(sessionId: string, now: number): Promise<BawWalletSessionRecord | null> {
        await this.ready
        const rows = await this.postgres`
            SELECT address, expires_at FROM baw_auth_sessions
            WHERE session_id = ${sessionId} AND revoked_at IS NULL AND expires_at > ${now}
        `
        return rows[0] ? { address: String(rows[0].address), expiresAt: Number(rows[0].expires_at) } : null
    }

    async revokeSession(sessionId: string, now: number): Promise<void> {
        await this.ready
        await this.postgres`
            UPDATE baw_auth_sessions SET revoked_at = ${now}
            WHERE session_id = ${sessionId} AND revoked_at IS NULL
        `
    }

    private async runMigrations(): Promise<void> {
        await this.postgres.begin(async (transaction) => {
            await transaction`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`
            await transaction`
                CREATE TABLE IF NOT EXISTS baw_execution_schema_migrations (
                    version integer PRIMARY KEY,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
            `
            for (const migration of MIGRATIONS) {
                const applied = await transaction`
                    SELECT version FROM baw_execution_schema_migrations WHERE version = ${migration.version}
                `
                if (applied.length) continue
                for (const statement of migration.statements) await transaction.unsafe(statement)
                await transaction`
                    INSERT INTO baw_execution_schema_migrations (version) VALUES (${migration.version})
                `
            }
        })
    }
}

let defaultStore: BawExecutionStore | null = null

export function getDefaultBawExecutionStore(): BawExecutionStore {
    if (!defaultStore) defaultStore = new BawExecutionStore()
    return defaultStore
}

function isPostgresUrl(value: string): boolean {
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

function isPostgresConflict(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
}

function isLocalDevelopmentUrl(value: string): boolean {
    if (process.env.NODE_ENV === "production") return false
    try {
        return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname)
    } catch {
        return false
    }
}

function safeHashMatch(stored: string, requested: string): boolean {
    const storedHash = Buffer.from(stored, "hex")
    const requestedHash = Buffer.from(requested, "hex")
    return storedHash.length === requestedHash.length &&
        storedHash.length > 0 &&
        timingSafeEqual(storedHash, requestedHash)
}

function parseRecord(value: unknown): BawExecutionRecord {
    return (typeof value === "string" ? JSON.parse(value) : value) as BawExecutionRecord
}
