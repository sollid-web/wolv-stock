import {
    BawExecutionError,
    reconcileBawExecution,
    sanitizeBawExecutionRecord,
} from "../../../../services/bawExecution.ts"
import { authorizeBawWalletRequest } from "../../../../services/bawWalletAuth.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request): Promise<Response> {
    const authorization = await authorizeBawWalletRequest(request, process.env.BAW_WALLET_API_TOKEN)
    if (authorization === "not_configured") {
        return Response.json({ error: "Operator wallet access is not configured on this host." }, { status: 503 })
    }
    if (authorization === "unauthorized") {
        return Response.json({ error: "The operator access token is missing or invalid." }, { status: 401 })
    }
    if (authorization === "storage_unavailable") {
        return Response.json(
            { error: "Browser-wallet authentication storage is unavailable." },
            { status: 503, headers: { "Cache-Control": "no-store" } },
        )
    }
    const executionId = new URL(request.url).searchParams.get("executionId")
    if (!executionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(executionId)) {
        return Response.json({ error: "A valid executionId is required." }, { status: 400 })
    }
    try {
        const execution = await reconcileBawExecution(executionId, {})
        return Response.json({ execution: sanitizeBawExecutionRecord(execution) }, { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        if (error instanceof BawExecutionError) {
            return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } })
        }
        console.error("BAW execution status could not be reconciled:", error)
        return Response.json({ error: "BAW execution status could not be verified." }, { status: 502, headers: { "Cache-Control": "no-store" } })
    }
}
