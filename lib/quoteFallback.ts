import type { Q } from "@/lib/quotes";

/** Sizes tried in order when the aggregator reports insufficient liquidity (Binance 40374). */
export const QUOTE_FALLBACK_SIZES_USDT = [100, 25, 10] as const;

export type QuoteFailureReason = "no_liquidity" | "rate_limited" | "unavailable";

export function classifyQuoteError(message: string): QuoteFailureReason {
  if (/40374|insufficient liquidity/i.test(message)) return "no_liquidity";
  if (/42900|rate limit/i.test(message)) return "rate_limited";
  return "unavailable";
}

/**
 * Requests an indicative quote at the default size and, only when the aggregator reports
 * insufficient liquidity, retries at smaller sizes. Any other error stops immediately (no extra
 * load on rate limits). The returned quote carries the size it was obtained at.
 */
export async function quoteWithSizeFallback(
  quoter: (sizeUsdt: number) => Promise<Q>,
  sizes: readonly number[] = QUOTE_FALLBACK_SIZES_USDT,
): Promise<Q & { sizeUsdt?: number; reason?: QuoteFailureReason }> {
  let last: Q | null = null;
  for (const size of sizes) {
    const quote = await quoter(size);
    if (quote.ok) return { ...quote, sizeUsdt: size };
    last = quote;
    if (classifyQuoteError(quote.err) !== "no_liquidity") break;
  }
  const failure = last ?? { ok: false as const, err: "no quote requested", ts: Date.now() };
  return { ...failure, reason: failure.ok ? undefined : classifyQuoteError(failure.err) };
}
