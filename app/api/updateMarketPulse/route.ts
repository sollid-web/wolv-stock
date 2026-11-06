import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { updateMarketPulse } from "@/lib/marketPulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authorization);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

async function handleUpdate(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: "Market pulse cron authorization is not configured." }, { status: 503 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "A valid cron authorization is required." }, { status: 401 });
  }

  try {
    const result = await updateMarketPulse();
    return NextResponse.json({ ...result, updatedAt: new Date().toISOString() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Market pulse update failed:", error);
    return NextResponse.json(
      { error: "Market pulse update failed. Check the server logs for details." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = handleUpdate;
export const POST = handleUpdate;
