export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json(
    { error: "BAW execution reconciliation is unavailable during Phase 4.0.", execution: "BLOCKED" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
