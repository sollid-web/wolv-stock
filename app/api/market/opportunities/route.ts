import { NextResponse } from "next/server";
import { readMarketOpportunities } from "@/services/marketPriceCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "CLEARED" && status !== "ALL") {
      return NextResponse.json({ ok: false, error: "status must be ACTIVE, CLEARED or ALL." }, { status: 400 });
    }
    const opportunities = await readMarketOpportunities({ status, limit: Number(url.searchParams.get("limit") ?? 50) });
    return NextResponse.json({
      ok: true, source: "supabase-opportunity-scanner", opportunities,
      activeCount: opportunities.filter((item) => item.status === "ACTIVE" && !item.stale).length,
      staleCount: opportunities.filter((item) => item.stale).length,
      asOf: new Date().toISOString(),
      disclaimer: "Reference-price dislocations are research signals, not executable quotes or guaranteed profit.",
    }, { headers: { "Cache-Control": "public, s-maxage=2, stale-while-revalidate=5" } });
  } catch {
    return NextResponse.json({ ok: false, error: "Opportunity data is unavailable." }, { status: 503 });
  }
}
