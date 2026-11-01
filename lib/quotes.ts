import { getRWAQuote } from "@/lib/binance";
import { OPPORTUNITY_QUOTE_TTL_MS } from "@/lib/opportunityMath";
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isPositiveUint256 } from "./apiValidation";
import { validateQuote } from "@/lib/quoteValidation";

export type QuoteSuccess = {
  ok: true;
  usd: number;
  walletBound?: boolean;
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
  binanceChainId?: string;
  fromTokenAmount?: string;
  toTokenAmount?: string | number;
  fromToken?: { tokenContractAddress?: string; tokenUnitPrice?: string | number; decimal?: string };
  toToken?: { tokenContractAddress?: string; decimal?: string };
  executionMode?: string;
  vendorName?: string;
  priceImpactPercent?: string | number;
};

const cache = new Map<string, Q>();
export const QUOTE_TTL_MS = OPPORTUNITY_QUOTE_TTL_MS;
let last = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isQuoteRoute(value: unknown): value is QuoteRoute {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isProviderIntegerAmount(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value) && isPositiveUint256(value);
}

function matchesTokenAddress(value: unknown, expected: string): boolean {
  return typeof value === "string" &&
    EVM_ADDRESS_PATTERN.test(value) &&
    value.toLowerCase() === expected.toLowerCase();
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
      const requestedAmount = String(usdt) + "0".repeat(18);
      const response: unknown = await getRWAQuote(addr, requestedAmount);
      const routes = isRecord(response) && Array.isArray(response.data)
        ? response.data.filter((route): route is QuoteRoute =>
            isQuoteRoute(route) && isProviderIntegerAmount(route.toTokenAmount)
          )
        : [];
      routes.sort((a, b) => Number(b.toTokenAmount ?? 0) - Number(a.toTokenAmount ?? 0));
      const best = routes[0];
      const output = asFiniteNumber(best?.toTokenAmount);
      if (
        !best ||
        output == null ||
        output <= 0 ||
        best.binanceChainId !== "56" ||
        best.executionMode !== "RFQ" ||
        best.fromTokenAmount !== requestedAmount ||
        !matchesTokenAddress(best.fromToken?.tokenContractAddress, BSC_USDT_ADDRESS) ||
        !matchesTokenAddress(best.toToken?.tokenContractAddress, addr) ||
        typeof best.fromToken?.decimal !== "string" ||
        typeof best.toToken?.decimal !== "string"
      ) {
        const message = isRecord(response) && typeof response.msg === "string" ? response.msg : "no route";
        throw new Error(message);
      }

      const validation = validateQuote({
        fromTokenAmount: best.fromTokenAmount,
        toTokenAmount: best.toTokenAmount,
        fromTokenDecimals: best.fromToken.decimal,
        toTokenDecimals: best.toToken.decimal,
        tokenUnitPrice: best.fromToken.tokenUnitPrice,
        expectedFromTokenAmount: requestedAmount,
      });
      if (!validation.ok) throw new Error(validation.reason);
      const impact = asFiniteNumber(best.priceImpactPercent);
      const quote: QuoteSuccess = {
        ok: true,
        usd: validation.usd,
        walletBound: false,
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
