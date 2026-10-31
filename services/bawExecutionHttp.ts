import { authorizeBawWalletRequest } from "./bawWalletAuth.ts"
import { BawCliError } from "./bawCli.ts"
import {
    BawExecutionError,
    createBawExecutionApproval,
    executeApprovedBawTrade,
    sanitizeBawExecutionRecord,
    type BawExecutionDependencies,
} from "./bawExecution.ts"

const MAX_BODY_BYTES = 16_384
const HEADERS = { "Cache-Control": "no-store" }

export async function handleBawApprovalPost(
    request: Request,
    dependencies: BawExecutionDependencies & { configuredToken?: string },
): Promise<Response> {
    const authorization = await authorizeBawWalletRequest(
        request,
        dependencies.configuredToken ?? process.env.BAW_WALLET_API_TOKEN,
    )
    if (authorization !== "authorized") return authError(authorization)
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return rejected("INVALID_REQUEST", "Content-Type must be application/json.", 400)
    }
    const parsedBody = await readBoundedJson(request)
    if (!parsedBody.ok) return rejected("INVALID_REQUEST", parsedBody.message, parsedBody.status)
    if (!isRecord(parsedBody.value) || !hasExactKeys(parsedBody.value, ["quote"])) {
        return rejected("INVALID_REQUEST", "Request must contain only the quote to approve.", 422)
    }
    try {
        const approval = await createBawExecutionApproval(parsedBody.value.quote, dependencies)
        return Response.json({ status: "APPROVAL_REQUIRED", ...approval }, { status: 201, headers: HEADERS })
    } catch (error) {
        return executionError(error)
    }
}

export async function handleBawExecutionAction(
    request: Request,
    body: unknown,
    dependencies: BawExecutionDependencies & { configuredToken?: string },
): Promise<Response> {
    const authorization = await authorizeBawWalletRequest(
        request,
        dependencies.configuredToken ?? process.env.BAW_WALLET_API_TOKEN,
    )
    if (authorization !== "authorized") return authError(authorization)
    if (
        !isRecord(body) ||
        !hasExactKeys(body, ["action", "executionId", "approvalToken", "securityAuditAcknowledged"]) ||
        body.action !== "executeBaw" ||
        typeof body.executionId !== "string" ||
        typeof body.approvalToken !== "string" ||
        body.securityAuditAcknowledged !== true
    ) return rejected("INVALID_REQUEST", "A valid one-time approval token and execution ID are required.", 422)
    try {
        const execution = await executeApprovedBawTrade({
            executionId: body.executionId,
            approvalToken: body.approvalToken,
            securityAuditAcknowledged: body.securityAuditAcknowledged,
        }, dependencies)
        return Response.json({ execution: sanitizeBawExecutionRecord(execution) }, { headers: HEADERS })
    } catch (error) {
        return executionError(error)
    }
}

function authError(authorization: "authorized" | "unauthorized" | "not_configured" | "storage_unavailable"): Response {
    if (authorization === "not_configured") {
        return rejected("BAW_ACCESS_NOT_CONFIGURED", "Operator wallet access is not configured on this host.", 503)
    }
    if (authorization === "storage_unavailable") {
        return rejected("BAW_AUTH_STORAGE_UNAVAILABLE", "Browser-wallet authentication storage is unavailable.", 503)
    }
    return rejected("BAW_ACCESS_DENIED", "The operator access token is missing or invalid.", 401)
}

function executionError(error: unknown): Response {
    if (error instanceof BawExecutionError) {
        return rejected(error.code, error.message, error.status)
    }
    if (error instanceof BawCliError) {
        if (error.code === "BAW_TIMEOUT") {
            return rejected(error.code, "The BAW CLI did not respond before its timeout.", 504)
        }
        if (error.code === "BAW_RATE_LIMITED") {
            return rejected(error.code, "The BAW rate limit was reached; no alternate slippage or execution path will be used.", 429)
        }
        if (error.code === "BAW_UNAVAILABLE") {
            return rejected(error.code, "The BAW CLI is unavailable on this host.", 503)
        }
        return rejected(error.code, "The BAW CLI response could not be validated.", 502)
    }
    console.error("BAW execution request failed:", error)
    return rejected("EXECUTION_UNAVAILABLE", "BAW execution could not be completed safely.", 502)
}

function rejected(code: string, message: string, status: number): Response {
    return Response.json({ status: "REJECTED", code, error: message }, { status, headers: HEADERS })
}

type JsonBodyResult =
    | { ok: true; value: unknown }
    | { ok: false; status: 400 | 413; message: string }

async function readBoundedJson(request: Request): Promise<JsonBodyResult> {
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
        return {
            ok: false,
            status: Number(contentLength) > MAX_BODY_BYTES ? 413 : 400,
            message: "Request body is invalid or exceeds the 16 KB limit.",
        }
    }
    const reader = request.body?.getReader()
    if (!reader) return { ok: false, status: 400, message: "Request body must contain valid JSON." }
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_BODY_BYTES) {
                await reader.cancel().catch(() => undefined)
                return { ok: false, status: 413, message: "Request body exceeds the 16 KB limit." }
            }
            chunks.push(value)
        }
    } catch {
        return { ok: false, status: 400, message: "Request body could not be read." }
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
        return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
    } catch {
        return { ok: false, status: 400, message: "Request body must be valid UTF-8 JSON." }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    return Object.keys(record).length === expected.length && expected.every((key) => Object.hasOwn(record, key))
}
