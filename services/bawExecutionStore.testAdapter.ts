import { timingSafeEqual } from "node:crypto"
import {
    BawExecutionStoreError,
    type BawExecutionRecord,
    type BawExecutionStorePort,
    type BawWalletSessionRecord,
} from "./bawExecutionStore.ts"

const ACTIVE_STATES = new Set(["APPROVAL_REQUIRED", "APPROVED", "SUBMITTING", "SUBMITTED", "PENDING", "PARTIALLY_FILLED", "UNKNOWN"])

type ApprovalRecord = {
    record: BawExecutionRecord
    tokenHash: string
    tokenUsed: boolean
    expiresAt: number
    createdAt: number
}

export class BawExecutionMemoryTestStore implements BawExecutionStorePort {
    private readonly records = new Map<string, ApprovalRecord>()
    private readonly challenges = new Map<string, { address: string; expiresAt: number }>()
    private readonly sessions = new Map<string, BawWalletSessionRecord & { revokedAt: number | null }>()

    async close(): Promise<void> {
        this.records.clear()
        this.challenges.clear()
        this.sessions.clear()
    }

    async createApproval(record: BawExecutionRecord, tokenHash: string, expiresAt: number, createdAt = Date.now()): Promise<void> {
        for (const [id, value] of this.records) {
            if (value.record.state === "APPROVAL_REQUIRED" && value.expiresAt <= createdAt) {
                value.record.state = "EXPIRED"
            }
            if (id === record.executionId || ACTIVE_STATES.has(value.record.state)) {
                throw new BawExecutionStoreError("BUSY")
            }
        }
        this.records.set(record.executionId, {
            record: structuredClone(record),
            tokenHash,
            tokenUsed: false,
            expiresAt,
            createdAt,
        })
    }

    async consumeApproval(executionId: string, tokenHash: string, now: number): Promise<BawExecutionRecord> {
        const approval = this.records.get(executionId)
        if (!approval) throw new BawExecutionStoreError("NOT_FOUND")
        if (
            approval.tokenUsed ||
            approval.record.state !== "APPROVAL_REQUIRED" ||
            !safeHashMatch(approval.tokenHash, tokenHash)
        ) throw new BawExecutionStoreError("USED")
        if (now >= approval.expiresAt) {
            approval.record.state = "EXPIRED"
            throw new BawExecutionStoreError("EXPIRED")
        }
        approval.tokenUsed = true
        approval.record.state = "APPROVED"
        approval.record.submittedAt = null
        return structuredClone(approval.record)
    }

    async update(record: BawExecutionRecord): Promise<void> {
        const stored = this.records.get(record.executionId)
        if (!stored) throw new BawExecutionStoreError("NOT_FOUND")
        stored.record = structuredClone(record)
    }

    async get(executionId: string): Promise<BawExecutionRecord | null> {
        const record = this.records.get(executionId)?.record
        return record ? structuredClone(record) : null
    }

    async dailyNotionalSince(startOfDay: number, excludeExecutionId?: string): Promise<number> {
        let total = 0
        for (const [executionId, value] of this.records) {
            if (
                value.createdAt >= startOfDay &&
                !["APPROVAL_REQUIRED", "APPROVED", "EXPIRED"].includes(value.record.state) &&
                executionId !== excludeExecutionId
            ) total += value.record.notionalUsd
        }
        return total
    }

    async createChallenge(nonceHash: string, address: string, expiresAt: number): Promise<void> {
        if (this.challenges.has(nonceHash)) throw new BawExecutionStoreError("DUPLICATE")
        this.challenges.set(nonceHash, { address, expiresAt })
    }

    async consumeChallengeAndCreateSession(
        nonceHash: string,
        address: string,
        now: number,
        sessionId: string,
        expiresAt: number,
    ): Promise<boolean> {
        const challenge = this.challenges.get(nonceHash)
        if (!challenge || challenge.address !== address || challenge.expiresAt <= now) return false
        this.challenges.delete(nonceHash)
        this.sessions.set(sessionId, { address, expiresAt, revokedAt: null })
        return true
    }

    async getSession(sessionId: string, now: number): Promise<BawWalletSessionRecord | null> {
        const session = this.sessions.get(sessionId)
        if (!session || session.revokedAt !== null || session.expiresAt <= now) return null
        return { address: session.address, expiresAt: session.expiresAt }
    }

    async revokeSession(sessionId: string, now: number): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session && session.revokedAt === null) session.revokedAt = now
    }
}

function safeHashMatch(stored: string, requested: string): boolean {
    const storedHash = Buffer.from(stored, "hex")
    const requestedHash = Buffer.from(requested, "hex")
    return storedHash.length === requestedHash.length &&
        storedHash.length > 0 &&
        timingSafeEqual(storedHash, requestedHash)
}
