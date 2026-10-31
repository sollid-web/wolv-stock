import { BawCliError, readWalletSnapshot, type BawWalletSnapshot } from "../../../../services/bawCli.ts"
import { authorizeBawWalletRequest } from "../../../../services/bawWalletAuth.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const responseHeaders = { "Cache-Control": "no-store" }

function errorResponse(error: BawCliError): Response {
    if (error.code === "BAW_UNAVAILABLE") {
        return Response.json(
            { error: "BAW_UNAVAILABLE", message: "Binance Agentic Wallet CLI is not available on this host." },
            { status: 503, headers: responseHeaders }
        )
    }
    if (error.code === "BAW_TIMEOUT") {
        return Response.json(
            { error: "BAW_TIMEOUT", message: "Binance Agentic Wallet CLI did not respond in time." },
            { status: 504, headers: responseHeaders }
        )
    }
    return Response.json(
        { error: error.code, message: "Binance Agentic Wallet status could not be read." },
        { status: 502, headers: responseHeaders }
    )
}

export async function GET(request: Request): Promise<Response> {
    const authorization = await authorizeBawWalletRequest(request, process.env.BAW_WALLET_API_TOKEN)
    if (authorization === "not_configured") {
        return Response.json(
            { error: "BAW_ACCESS_NOT_CONFIGURED", message: "Operator wallet access is not configured on this host." },
            { status: 503, headers: { "Cache-Control": "no-store" } }
        )
    }
    if (authorization === "unauthorized") {
        return Response.json(
            { error: "BAW_ACCESS_DENIED", message: "The operator access token is missing or invalid." },
            { status: 401, headers: { "Cache-Control": "no-store" } }
        )
    }
    if (authorization === "storage_unavailable") {
        return Response.json(
            { error: "BAW_AUTH_STORAGE_UNAVAILABLE", message: "Browser-wallet authentication storage is unavailable." },
            { status: 503, headers: responseHeaders }
        )
    }

    let snapshot: BawWalletSnapshot
    try {
        snapshot = await readWalletSnapshot()
    } catch (error) {
        if (error instanceof BawCliError) return errorResponse(error)
        return Response.json(
            { error: "BAW_COMMAND_FAILED", message: "Binance Agentic Wallet status could not be read." },
            { status: 502, headers: responseHeaders }
        )
    }
    return Response.json(snapshot, { status: 200, headers: responseHeaders })
}
