import { authorizeBawWalletRequest } from "./bawWalletAuth.ts"
import {
    BawQuoteError,
    parseAgentQuoteInput,
    type AgentQuoteInput,
    type AgentQuoteResponse,
} from "./bawQuote.ts"
import { BawCliError } from "./bawCli.ts"

const MAX_REQUEST_BYTES = 8_192
const RESPONSE_HEADERS = { "Cache-Control": "no-store" }

type JsonBodyResult =
    | { ok: true; value: unknown }
    | { ok: false; status: 400 | 413; message: string }

export type BawQuoteHttpDependencies = {
    configuredToken?: string
    quote?: (input: AgentQuoteInput) => Promise<AgentQuoteResponse>
}

export async function handleBawQuotePost(
    request: Request,
    dependencies: BawQuoteHttpDependencies = {},
): Promise<Response> {
    const authorization = await authorizeBawWalletRequest(
        request,
        dependencies.configuredToken ?? process.env.BAW_WALLET_API_TOKEN,
    )
    if (authorization === "not_configured") {
        return rejected("BAW_ACCESS_NOT_CONFIGURED", "Operator wallet access is not configured on this host.", 503)
    }
    if (authorization === "unauthorized") {
        return rejected("BAW_ACCESS_DENIED", "The operator access token is missing or invalid.", 401)
    }
    if (authorization === "storage_unavailable") {
        return rejected("BAW_AUTH_STORAGE_UNAVAILABLE", "Browser-wallet authentication storage is unavailable.", 503)
    }

    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return rejected("INVALID_REQUEST", "Content-Type must be application/json.", 400)
    }
    const body = await readBoundedJson(request)
    if (!body.ok) return rejected("INVALID_REQUEST", body.message, body.status)

    const parsedInput = parseAgentQuoteInput(body.value)
    if (!parsedInput.ok) return rejected("INVALID_REQUEST", parsedInput.reason, 422)

    try {
        const quote = await (dependencies.quote ?? defaultQuoteUnavailable)(parsedInput.input)
        return Response.json(quote, { status: 200, headers: RESPONSE_HEADERS })
    } catch (error) {
        if (error instanceof BawQuoteError) {
            return rejected(error.code, error.message, error.status)
        }
        if (error instanceof BawCliError) {
            return mapCliError(error)
        }
        console.error("BAW quote request failed:", error)
        return rejected("QUOTE_UNAVAILABLE", "The BAW quote service is temporarily unavailable.", 502)
    }
}

function defaultQuoteUnavailable(): Promise<AgentQuoteResponse> {
    return Promise.reject(new Error("BAW quote service dependency is not configured"))
}

function mapCliError(error: BawCliError): Response {
    if (error.code === "BAW_UNAVAILABLE") {
        return rejected(error.code, "Binance Agentic Wallet CLI is not available on this host.", 503)
    }
    if (error.code === "BAW_TIMEOUT") {
        return rejected(error.code, "Binance Agentic Wallet CLI did not respond in time.", 504)
    }
    if (error.code === "BAW_RATE_LIMITED") {
        return rejected(error.code, "Binance Agentic Wallet rate limit was reached. Retry after a delay.", 429)
    }
    return rejected(error.code, "Binance Agentic Wallet returned an invalid or unsuccessful quote response.", 502)
}

function rejected(code: string, message: string, status: number): Response {
    return Response.json(
        { status: "REJECTED", code, error: message, rejectionReasons: [message] },
        { status, headers: RESPONSE_HEADERS },
    )
}

async function readBoundedJson(request: Request): Promise<JsonBodyResult> {
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null) {
        if (!/^\d+$/.test(contentLength)) {
            return { ok: false, status: 400, message: "Content-Length must be a non-negative integer." }
        }
        if (Number(contentLength) > MAX_REQUEST_BYTES) {
            return { ok: false, status: 413, message: "Request body exceeds the 8 KB limit." }
        }
    }

    const reader = request.body?.getReader()
    if (!reader) return { ok: false, status: 400, message: "Request body must contain valid JSON." }

    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            totalBytes += value.byteLength
            if (totalBytes > MAX_REQUEST_BYTES) {
                await reader.cancel().catch(() => undefined)
                return { ok: false, status: 413, message: "Request body exceeds the 8 KB limit." }
            }
            chunks.push(value)
        }
    } catch {
        return { ok: false, status: 400, message: "Request body could not be read." }
    } finally {
        reader.releaseLock()
    }

    try {
        const bytes = new Uint8Array(totalBytes)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        return { ok: true, value: JSON.parse(text) as unknown }
    } catch {
        return { ok: false, status: 400, message: "Request body must be valid UTF-8 JSON." }
    }
}
