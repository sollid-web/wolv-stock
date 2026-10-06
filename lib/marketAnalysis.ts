import { MAX_RELIABLE_GAP_PERCENT } from "./marketThresholds.js";

export type AnalysisRequest = { ticker: string };

export type VenueAnalysisInput = {
  platform: string;
  status: string;
  referencePerShare: number | null;
  executablePerShare: number | null;
  referenceGap: number | null;
  quoteAgeSeconds: number | null;
  stale: boolean;
  unreliable: boolean;
  quoteAvailable: boolean;
};

export type MarketAnalysisInput = {
  ticker: string;
  spread: number | null;
  statusMismatch: boolean;
  statuses: string[];
  venues: VenueAnalysisInput[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAnalysisRequest(value: unknown): AnalysisRequest | null {
  if (!isRecord(value)) return null;
  const ticker = value.ticker;
  if (typeof ticker !== "string") return null;
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,15}$/.test(normalized)) return null;
  return { ticker: normalized };
}

export function normalizeModelSummary(value: unknown, authoritativeText: string): string {
  if (!isRecord(value) || typeof value.summary !== "string") {
    throw new Error("AI analysis returned an invalid summary");
  }
  const summary = value.summary.trim().slice(0, 500);
  if (!summary) throw new Error("AI analysis returned an empty summary");
  if (/\b(buy|sell|short|long|purchase|recommend(?:ation)?|invest|profit|guarantee|risk[- ]free|can't lose|cannot lose|will rise|will fall|will increase|will decrease)\b/i.test(summary)) {
    throw new Error("AI analysis returned prohibited trading language");
  }
  const numericKey = (token: string) => {
    const percentage = token.endsWith("%");
    const value = Number(token.replace(/[%,+]/g, ""));
    return Number.isFinite(value) ? `${value}${percentage ? "%" : ""}` : null;
  };
  const allowedNumbers = new Set(
    (authoritativeText.match(/[+-]?\d[\d,]*(?:\.\d+)?%?/g) ?? [])
      .map(numericKey)
      .filter((value): value is string => value !== null)
  );
  const introducedNumber = (summary.match(/[+-]?\d[\d,]*(?:\.\d+)?%?/g) ?? [])
    .some((token) => {
      const key = numericKey(token);
      return key !== null && !allowedNumbers.has(key);
    });
  if (introducedNumber) throw new Error("AI analysis introduced an unsupported number");
  return summary;
}

export function buildRulesAnalysis(input: MarketAnalysisInput) {
  const fresh = input.venues.filter((venue) =>
    venue.quoteAvailable &&
    !venue.stale &&
    !venue.unreliable &&
    venue.referencePerShare != null &&
    venue.executablePerShare != null
  );
  const outliers = input.venues.filter((venue) => venue.unreliable);
  const missing = input.venues.filter((venue) => !venue.quoteAvailable || venue.referencePerShare == null || venue.executablePerShare == null);
  const reasons: string[] = [];
  let verdict = "Wait for a clearer comparison";
  let tone: "positive" | "caution" | "neutral" = "neutral";

  const statusList = input.statuses.join(" vs ");
  const venueNames = input.venues.map((v) => v.platform).join(" and ");

  if (input.statusMismatch) {
    const openVenues = input.venues.filter((v) => v.status === "open" || v.status === "regular").map((v) => v.platform);
    const closedVenues = input.venues.filter((v) => v.status !== "open" && v.status !== "regular").map((v) => v.platform);
    reasons.push(`${venueNames} report different market sessions (${statusList}). ${openVenues.length ? openVenues.join(", ") + " is trading" : "No venue is in regular session"}${closedVenues.length ? " while " + closedVenues.join(", ") + " is in " + (closedVenues.length === 1 ? input.venues.find(v => closedVenues.includes(v.platform))?.status ?? "a different session" : "off-hours") : ""}.`);
    reasons.push("Price gaps between sessions reflect different trading states, not an executable arbitrage. Wait for both venues to align before comparing spreads.");
    verdict = "Session mismatch — check again when venues align";
    tone = "caution";
  } else if (outliers.length > 0) {
    reasons.push(`${outliers.length} quote${outliers.length === 1 ? " is" : "s are"} outside WOLV's ±${MAX_RELIABLE_GAP_PERCENT}% reliability cap and excluded. This usually means thin liquidity or a stale reference price on that venue.`);
    verdict = "Caution — an outlier is excluded";
    tone = "caution";
  } else if (fresh.length >= 2 && input.spread != null) {
    const spreadAbs = Math.abs(input.spread);
    const spreadDir = input.spread >= 0 ? "above" : "below";
    reasons.push(`${fresh.length} fresh venue quotes are comparable after per-share normalization. ${input.ticker} is quoted ${spreadAbs.toFixed(3)}% ${spreadDir} reference price on the more expensive venue.`);
    reasons.push(`This ${spreadAbs.toFixed(3)}% spread is pre-fees. BSC gas, DEX slippage, and the quote-size effect (${100} USDT) all reduce the net difference. Request a live quote on the trade screen to see the exact execution price.`);
    verdict = spreadAbs < 0.5 ? "Tight spread — verify execution costs" : spreadAbs < 2 ? "Visible spread — check execution costs before acting" : "Wide spread — review carefully";
    tone = spreadAbs < 0.5 ? "neutral" : "positive";
  } else {
    reasons.push("There are not enough fresh, reference-backed quotes to produce a reliable comparison right now.");
    reasons.push("This can happen during low-liquidity periods or when a venue's reference price is not updating. Try again in a few minutes.");
    tone = "caution";
  }

  if (missing.length > 0) reasons.push(`${missing.length} venue${missing.length === 1 ? " has" : "s have"} missing or unusable comparison data.`);

  return {
    source: "WOLV rules · server verified",
    headline: `${input.ticker}: ${verdict}`,
    summary: `${input.ticker} is assessed from market data fetched on the server. This is informational context, not a guaranteed profit or investment recommendation.`,
    reasons,
    nextStep: tone === "caution" ? "Refresh the data before trading." : "Open the asset, request a fresh quote, and run the pre-check before wallet approval.",
    tone,
  };
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return { ok: false, status: 400 };
  }

  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
