import { NextResponse } from "next/server";
import { readLatestMarketPrices } from "@/services/marketPriceCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const ticker = url.searchParams.get("ticker") ?? undefined;
    const tokenAddress = url.searchParams.get("tokenAddress") ?? undefined;
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50;
    if (tokenAddress && !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
      return NextResponse.json({ ok: false, error: "Invalid tokenAddress." }, { status: 400 });
    }
    const prices = await readLatestMarketPrices({ ticker, tokenAddress, limit });
    return NextResponse.json({
      ok: true,
      source: "supabase-market-cache",
      prices,
      staleCount: prices.filter((price) => price.stale).length,
      asOf: new Date().toISOString(),
    }, {
      headers: { "Cache-Control": "public, s-maxage=2, stale-while-revalidate=5" },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Market-price cache is unavailable." }, { status: 503 });
  }
}
