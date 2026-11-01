export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(): Promise<Response> {
    return Response.json(
        { status: "REJECTED", code: "EXECUTION_BLOCKED", error: "BAW approvals are unavailable during Phase 4.0." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
    )
}
