import { BawCliError, readWalletSnapshot, type BawWalletSnapshot } from "@/services/bawCli"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function errorResponse(error: BawCliError): Response {
    if (error.code === "BAW_UNAVAILABLE") {
        return Response.json(
            { error: "BAW_UNAVAILABLE", message: "Binance Agentic Wallet CLI is not available on this host." },
            { status: 503 }
        )
    }
    if (error.code === "BAW_TIMEOUT") {
        return Response.json(
            { error: "BAW_TIMEOUT", message: "Binance Agentic Wallet CLI did not respond in time." },
            { status: 504 }
        )
    }
    return Response.json(
        { error: error.code, message: "Binance Agentic Wallet status could not be read." },
        { status: 502 }
    )
}

export async function GET(): Promise<Response> {
    let snapshot: BawWalletSnapshot
    try {
        snapshot = await readWalletSnapshot()
    } catch (error) {
        if (error instanceof BawCliError) return errorResponse(error)
        return Response.json(
            { error: "BAW_COMMAND_FAILED", message: "Binance Agentic Wallet status could not be read." },
            { status: 502 }
        )
    }
    return Response.json(snapshot, { status: 200, headers: { "Cache-Control": "no-store" } })
}
