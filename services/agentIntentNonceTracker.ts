import Redis from "ioredis"
import { getAddress, padHex, toHex, type Address, type Hex } from "viem"

export class AgentIntentNonceError extends Error {
    readonly cause?: unknown

    constructor(message: string, cause?: unknown) {
        super(message)
        this.name = "AgentIntentNonceError"
        this.cause = cause
    }
}

let redisClient: Redis | undefined
let redisUrl: string | undefined
let redisConnection: Promise<void> | undefined

function getRedisClient(url: string): Redis {
    if (redisClient && redisUrl !== url) {
        throw new AgentIntentNonceError("Redis URL cannot change while the nonce tracker is active.")
    }
    if (!redisClient) {
        redisUrl = url
        redisClient = new Redis(url, {
            lazyConnect: true,
            connectTimeout: 5_000,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            retryStrategy: retries => retries > 2 ? null : Math.min(retries * 250, 1_000)
        })
    }
    return redisClient
}

export function createIntentNonceAllocator(
    increment: (key: string) => Promise<number>
) {
    return async (smartAccount: Address): Promise<Hex> => {
        let account: Address
        try {
            account = getAddress(smartAccount)
        } catch (error) {
            throw new AgentIntentNonceError("Smart-account address is invalid.", error)
        }
        let sequence: number
        try {
            sequence = await increment(`wolv:agent:intent-nonce:${account.toLowerCase()}`)
        } catch (error) {
            throw new AgentIntentNonceError("Persistent intent nonce allocation failed.", error)
        }
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
            throw new AgentIntentNonceError("Persistent intent nonce counter is outside its safe range.")
        }
        return padHex(toHex(BigInt(sequence)), { size: 32 })
    }
}

export async function getNextIntentNonce(smartAccount: Address): Promise<Hex> {
    const url = process.env.REDIS_URL
    if (!url) throw new AgentIntentNonceError("REDIS_URL is required for persistent intent nonce allocation.")

    const client = getRedisClient(url)
    if (client.status === "wait") {
        redisConnection ??= client.connect().finally(() => {
            redisConnection = undefined
        })
        try {
            await redisConnection
        } catch (error) {
            throw new AgentIntentNonceError("Persistent intent nonce store is unavailable.", error)
        }
    }
    return createIntentNonceAllocator(key => client.incr(key))(smartAccount)
}

export async function closeIntentNonceTracker(): Promise<void> {
    const client = redisClient
    if (!client) return

    redisClient = undefined
    redisUrl = undefined
    redisConnection = undefined
    if (client.status === "ready") {
        await client.quit()
    } else {
        client.disconnect()
    }
}
