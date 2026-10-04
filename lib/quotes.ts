import { getRWAQuote } from "@/lib/binance";

export type QuoteSuccess = {
  ok: true;
  usd: number;
  mode: string;
  vendor: string;
  impact: number | null;
  ts: number;
};

export type QuoteFailure = {
  ok: false;
  err: string;
  ts: number;
};

export type Q = QuoteSuccess | QuoteFailure;

type QuoteRoute = {
  toTokenAmount?: string | number;
  fromToken?: { tokenUnitPrice?: string | number };
  executionMode?: string;
  vendorName?: string;
  priceImpactPercent?: string | number;
};

const cache = new Map<string, Q>();
export const QUOTE_TTL_MS = 30_000;
let last = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isQuoteRoute(value: unknown): value is QuoteRoute {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function quoteAgeSeconds(quote: Q, now = Date.now()): number {
  return Math.max(0, Math.floor((now - quote.ts) / 1000));
}

export function isQuoteFresh(quote: Q, now = Date.now()): boolean {
  return now - quote.ts < QUOTE_TTL_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// USD price of ONE TOKEN, from what `usdt` USDT actually buys (best route).
export async function quoteUsd(addr: string, usdt = 100): Promise<Q> {
  const hit = cache.get(addr);
  if (hit && isQuoteFresh(hit)) return hit;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = Math.max(0, last + 300 - Date.now());
    if (wait) await sleep(wait);
    last = Date.now();

    try {
      const response: unknown = await getRWAQuote(addr, String(usdt) + "0".repeat(18));
      const routes = isRecord(response) && Array.isArray(response.data)
        ? response.data.filter(isQuoteRoute)
        : [];
      routes.sort((a, b) => Number(b.toTokenAmount ?? 0) - Number(a.toTokenAmount ?? 0));
      const best = routes[0];
      const output = asFiniteNumber(best?.toTokenAmount);
      if (!best || output == null || output <= 0) {
        const message = isRecord(response) && typeof response.msg === "string" ? response.msg : "no route";
        throw new Error(message);
      }

      const unitPrice = asFiniteNumber(best.fromToken?.tokenUnitPrice) ?? 1;
      const impact = asFiniteNumber(best.priceImpactPercent);
      const quote: QuoteSuccess = {
        ok: true,
        usd: (usdt * unitPrice) / (output / 1e18),
        mode: best.executionMode ?? "unknown",
        vendor: best.vendorName ?? "unknown",
        impact,
        ts: Date.now(),
      };
      cache.set(addr, quote);
      return quote;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && msg.includes("42900")) { await sleep(1200); continue; }
      const q: Q = { ok: false, err: msg.slice(0, 140), ts: Date.now() };
      cache.set(addr, q);
      return q;
    }
  }

  return { ok: false, err: "rate limited", ts: Date.now() };
}
