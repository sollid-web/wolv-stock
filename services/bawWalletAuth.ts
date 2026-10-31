import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { getAddress, isAddress, verifyMessage, type Hex } from "viem"
import { EVM_ADDRESS_PATTERN } from "../lib/apiValidation.ts"
import {
    getDefaultBawExecutionStore,
    type BawExecutionStorePort,
} from "./bawExecutionStore.ts"

const MIN_TOKEN_BYTES = 32
const MAX_TOKEN_BYTES = 512
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/
const SECURE_SESSION_COOKIE = "__Host-wolv-baw-session"
const LOCAL_SESSION_COOKIE = "wolv-baw-session"
const SESSION_TTL_MS = 15 * 60_000
const CHALLENGE_TTL_MS = 2 * 60_000

type WalletSession = { address: string; expiresAt: number; sessionId: string }
type SessionChallenge = { address: string; message: string; expiresAt: number }
type AuthOptions = {
    store?: BawExecutionStorePort
    authorizedWallets?: string
    now?: number
}
export type BawWalletJsonResult =
    | { ok: true; value: unknown }
    | { ok: false; status: 400 | 413; message: string }

export type BawWalletAuthorization = "authorized" | "unauthorized" | "not_configured" | "storage_unavailable"

export function isBawWalletServerTokenConfigured(value: string | undefined): value is string {
    return isValidToken(value)
}

export function isBawBrowserWalletAllowlistConfigured(value = process.env.BAW_AUTHORIZED_BROWSER_WALLETS): boolean {
    if (!value) return false
    const addresses = value.split(",").map((address) => address.trim())
    return addresses.length > 0 && addresses.every(isValidBawWalletAddress)
}

export async function readBawWalletAuthJson(request: Request, maxBytes: number): Promise<BawWalletJsonResult> {
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
        return {
            ok: false,
            status: Number(contentLength) > maxBytes ? 413 : 400,
            message: "Authentication request is invalid or too large.",
        }
    }
    const reader = request.body?.getReader()
    if (!reader) return { ok: false, status: 400, message: "A valid JSON authentication request is required." }
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined)
                return { ok: false, status: 413, message: "Authentication request is too large." }
            }
            chunks.push(value)
        }
    } catch {
        return { ok: false, status: 400, message: "Authentication request could not be read." }
    } finally {
        reader.releaseLock()
    }
    try {
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        return {
            ok: true,
            value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
        }
    } catch {
        return { ok: false, status: 400, message: "Authentication request must be valid UTF-8 JSON." }
    }
}

export async function authorizeBawWalletRequest(
    request: Request,
    configuredToken: string | undefined,
    options: AuthOptions = {},
): Promise<BawWalletAuthorization> {
    if (!isValidToken(configuredToken)) return "not_configured"

    const authorization = request.headers.get("authorization")
    if (authorization !== null) {
        const providedToken = authorization.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : ""
        if (!isValidToken(providedToken)) return "unauthorized"
        return timingSafeTokenMatch(providedToken, configuredToken) ? "authorized" : "unauthorized"
    }

    if (!isSafeMethod(request.method) && !isSameOriginRequest(request)) return "unauthorized"
    try {
        return await getBawWalletSession(request, configuredToken, options) ? "authorized" : "unauthorized"
    } catch (error) {
        console.error("BAW browser session authorization storage failed:", error)
        return "storage_unavailable"
    }
}

export function isSameOriginRequest(request: Request): boolean {
    const origin = request.headers.get("origin")
    if (!origin) return false
    try {
        return new URL(origin).origin === new URL(request.url).origin
    } catch {
        return false
    }
}

export async function createBawWalletSessionChallenge(
    address: string,
    request: Request,
    configuredToken: string | undefined,
    options: AuthOptions = {},
): Promise<SessionChallenge | null> {
    if (!isValidToken(configuredToken) || !EVM_ADDRESS_PATTERN.test(address) || !isSameOriginRequest(request)) {
        return null
    }
    if (!isValidBawWalletAddress(address)) return null
    const canonicalAddress = getAddress(address).toLowerCase()
    if (!isAuthorizedBrowserWallet(canonicalAddress, options.authorizedWallets ?? process.env.BAW_AUTHORIZED_BROWSER_WALLETS)) {
        return null
    }
    const now = options.now ?? Date.now()
    const issuedAt = now
    const expiresAt = now + CHALLENGE_TTL_MS
    const origin = new URL(request.url).origin
    const nonce = randomBytes(32).toString("hex")
    const challengeBody = [
        "WOLV BAW application access",
        `Origin: ${origin}`,
        `Address: ${canonicalAddress}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
        `Expires At: ${expiresAt}`,
    ].join("\n")
    await getStore(options.store).createChallenge(hashNonce(nonce), canonicalAddress, expiresAt, issuedAt)
    return {
        address: canonicalAddress,
        message: `${challengeBody}\nChallenge: ${sign(challengeBody, configuredToken)}`,
        expiresAt,
    }
}

export async function createBawWalletSession(
    input: { address: string; message: string; signature: string },
    request: Request,
    configuredToken: string | undefined,
    options: AuthOptions = {},
): Promise<{ address: string; expiresAt: number; cookie: string } | null> {
    if (!isValidToken(configuredToken) || !isSameOriginRequest(request)) return null
    if (!EVM_ADDRESS_PATTERN.test(input.address) || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) return null
    const match = input.message.match(
        /^WOLV BAW application access\nOrigin: (https?:\/\/[^/\n]+)\nAddress: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{64})\nIssued At: (\d{13})\nExpires At: (\d{13})\nChallenge: ([A-Za-z0-9_-]{43})$/,
    )
    if (!match) return null
    const [, challengeOrigin, challengeAddress, nonce, issuedAtRaw, expiresAtRaw, challengeSignature] = match
    const now = options.now ?? Date.now()
    const issuedAt = Number(issuedAtRaw)
    const challengeExpiresAt = Number(expiresAtRaw)
    const challengeBody = input.message.slice(0, input.message.lastIndexOf("\nChallenge:"))
    if (!timingSafeTokenMatch(challengeSignature, sign(challengeBody, configuredToken))) return null
    if (!isValidBawWalletAddress(input.address)) return null
    const canonicalAddress = getAddress(input.address).toLowerCase()
    if (!isAuthorizedBrowserWallet(canonicalAddress, options.authorizedWallets ?? process.env.BAW_AUTHORIZED_BROWSER_WALLETS)) {
        return null
    }
    if (
        challengeOrigin !== new URL(request.url).origin ||
        challengeAddress.toLowerCase() !== canonicalAddress ||
        issuedAt > now + 10_000 ||
        now >= challengeExpiresAt ||
        challengeExpiresAt - issuedAt !== CHALLENGE_TTL_MS
    ) return null

    let signatureValid = false
    try {
        signatureValid = await verifyMessage({
            address: getAddress(input.address),
            message: input.message,
            signature: input.signature as Hex,
        })
    } catch {
        return null
    }
    if (!signatureValid) return null

    const expiresAt = now + SESSION_TTL_MS
    const sessionId = randomUUID()
    const created = await getStore(options.store).consumeChallengeAndCreateSession(
        hashNonce(nonce),
        canonicalAddress,
        now,
        sessionId,
        expiresAt,
    )
    if (!created) return null
    const payload = encodeSession({ address: canonicalAddress, expiresAt, sessionId })
    const signature = sign(payload, configuredToken)
    const cookieName = getSessionCookieName(request)
    return {
        address: canonicalAddress,
        expiresAt,
        cookie: `${cookieName}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${isSecureRequest(request) ? "; Secure" : ""}`,
    }
}

export async function getBawWalletSession(
    request: Request,
    configuredToken: string | undefined,
    options: AuthOptions = {},
): Promise<WalletSession | null> {
    if (!isValidToken(configuredToken)) return null
    const cookieHeader = request.headers.get("cookie")
    const cookieName = getSessionCookieName(request)
    const cookie = cookieHeader?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
    if (!cookie) return null
    const value = cookie.slice(cookieName.length + 1)
    const [payload, providedSignature, ...extra] = value.split(".")
    if (!payload || !providedSignature || extra.length) return null
    const expectedSignature = sign(payload, configuredToken)
    if (!timingSafeTokenMatch(providedSignature, expectedSignature)) return null
    let session: Partial<WalletSession>
    try {
        session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<WalletSession>
    } catch {
        return null
    }
    const now = options.now ?? Date.now()
    if (
        typeof session.address !== "string" ||
        !EVM_ADDRESS_PATTERN.test(session.address) ||
        typeof session.expiresAt !== "number" ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= now ||
        typeof session.sessionId !== "string" ||
        !isUuid(session.sessionId) ||
        !isAuthorizedBrowserWallet(session.address, options.authorizedWallets ?? process.env.BAW_AUTHORIZED_BROWSER_WALLETS)
    ) return null
    const stored = await getStore(options.store).getSession(session.sessionId, now)
    if (
        !stored ||
        stored.address.toLowerCase() !== session.address.toLowerCase() ||
        stored.expiresAt !== session.expiresAt
    ) return null
    return { address: session.address, expiresAt: session.expiresAt, sessionId: session.sessionId }
}

export async function revokeBawWalletSession(
    request: Request,
    configuredToken: string | undefined,
    options: AuthOptions = {},
): Promise<void> {
    if (!isValidToken(configuredToken)) return
    const cookieHeader = request.headers.get("cookie")
    const cookieName = getSessionCookieName(request)
    const cookie = cookieHeader?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
    if (!cookie) return
    const value = cookie.slice(cookieName.length + 1)
    const [payload, providedSignature, ...extra] = value.split(".")
    if (!payload || !providedSignature || extra.length) return
    if (!timingSafeTokenMatch(providedSignature, sign(payload, configuredToken))) return
    try {
        const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<WalletSession>
        if (typeof session.sessionId === "string" && isUuid(session.sessionId)) {
            await getStore(options.store).revokeSession(session.sessionId, options.now ?? Date.now())
        }
    } catch {
        throw new Error("BAW browser session could not be revoked.")
    }
}

export function clearBawWalletSessionCookie(request: Request): string {
    return `${getSessionCookieName(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecureRequest(request) ? "; Secure" : ""}`
}

export function isValidBawWalletAddress(value: string): boolean {
    return EVM_ADDRESS_PATTERN.test(value) && isAddress(value)
}

function isValidToken(value: string | undefined): value is string {
    if (value === undefined) return false
    const token = Buffer.from(value)
    return token.length >= MIN_TOKEN_BYTES
        && token.length <= MAX_TOKEN_BYTES
        && TOKEN_PATTERN.test(value)
}

function timingSafeTokenMatch(provided: string, expected: string): boolean {
    const providedBytes = Buffer.from(provided)
    const expectedBytes = Buffer.from(expected)
    return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

function encodeSession(session: WalletSession): string {
    return Buffer.from(JSON.stringify(session), "utf8").toString("base64url")
}

function isAuthorizedBrowserWallet(address: string, configuredAddresses: string | undefined): boolean {
    if (!configuredAddresses || !isBawBrowserWalletAllowlistConfigured(configuredAddresses)) return false
    const addresses = configuredAddresses.split(",").map((value) => value.trim())
    const canonicalAddress = address.toLowerCase()
    return addresses.some((value) => getAddress(value).toLowerCase() === canonicalAddress)
}

function hashNonce(nonce: string): string {
    return createHash("sha256").update(nonce).digest("hex")
}

function getStore(store?: BawExecutionStorePort): BawExecutionStorePort {
    return store ?? getDefaultBawExecutionStore()
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function sign(payload: string, configuredToken: string): string {
    const key = createHmac("sha256", configuredToken).update("wolv-baw-session-v1", "utf8").digest()
    return createHmac("sha256", key).update(payload, "utf8").digest("base64url")
}

function isSafeMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS"
}

function isSecureRequest(request: Request): boolean {
    return new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production"
}

function getSessionCookieName(request: Request): string {
    return isSecureRequest(request) ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
}
