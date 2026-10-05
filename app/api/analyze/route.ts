import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_RELIABLE_GAP = 20;

type VenueInput = {
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

type AnalysisInput = {
  ticker: string;
  company: string;
  spread: number | null;
  statusMismatch: boolean;
  statuses: string[];
  venues: VenueInput[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown, fallback: string, max = 120): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function parseInput(value: unknown): AnalysisInput | null {
  if (!isRecord(value)) return null;
  const venues = Array.isArray(value.venues) ? value.venues : [];
  if (!venues.length || venues.length > 8) return null;
  const parsedVenues: VenueInput[] = [];
  for (const item of venues) {
    if (!isRecord(item)) return null;
    parsedVenues.push({
      platform: cleanText(item.platform, "unknown", 40),
      status: cleanText(item.status, "status unavailable", 40),
      referencePerShare: finiteOrNull(item.referencePerShare),
      executablePerShare: finiteOrNull(item.executablePerShare),
      referenceGap: finiteOrNull(item.referenceGap),
      quoteAgeSeconds: finiteOrNull(item.quoteAgeSeconds),
      stale: item.stale === true,
      unreliable: item.unreliable === true,
      quoteAvailable: item.quoteAvailable === true,
    });
  }
  return {
    ticker: cleanText(value.ticker, "asset", 16),
    company: cleanText(value.company, "tokenized stock", 100),
    spread: finiteOrNull(value.spread),
    statusMismatch: value.statusMismatch === true,
    statuses: Array.isArray(value.statuses) ? value.statuses.filter((status): status is string => typeof status === "string").slice(0, 8) : [],
    venues: parsedVenues,
  };
}

function fallbackAnalysis(input: AnalysisInput) {
  const fresh = input.venues.filter((venue) => venue.quoteAvailable && !venue.stale && !venue.unreliable);
  const outliers = input.venues.filter((venue) => venue.unreliable);
  const missing = input.venues.filter((venue) => !venue.quoteAvailable || venue.referencePerShare == null || venue.executablePerShare == null);
  const reasons: string[] = [];
  let verdict = "Wait for a clearer comparison";
  let tone: "positive" | "caution" | "neutral" = "neutral";

  if (input.statusMismatch) {
    reasons.push(`The venues report different market sessions (${input.statuses.join(" vs ")}), so the spread may reflect timing rather than a tradable difference.`);
    verdict = "Session mismatch — check again when venues align";
    tone = "caution";
  } else if (outliers.length > 0) {
    reasons.push(`${outliers.length} quote${outliers.length === 1 ? " is" : "s are"} outside WOLV's ±${MAX_RELIABLE_GAP}% reliability cap and excluded from the comparison.`);
    verdict = "Caution — an outlier is excluded";
    tone = "caution";
  } else if (fresh.length >= 2 && input.spread != null) {
    reasons.push(`${fresh.length} fresh venue quotes can be compared after token/share normalization.`);
    reasons.push(`The displayed cross-venue spread is ${input.spread >= 0 ? "+" : ""}${input.spread.toFixed(3)}% before fees, gas, slippage, and execution changes.`);
    verdict = input.spread < 1 ? "Small difference — verify the latest quote" : "Meaningful difference — verify execution costs";
    tone = input.spread < 1 ? "neutral" : "positive";
  } else {
    reasons.push("There are not enough fresh, reference-backed quotes to call this a reliable opportunity.");
    tone = "caution";
  }

  if (missing.length > 0) reasons.push(`${missing.length} venue${missing.length === 1 ? " has" : "s have"} missing or unusable comparison data.`);

  return {
    source: "WOLV rules",
    headline: `${input.ticker}: ${verdict}`,
    summary: `${input.company} is being assessed from the live reference and executable data currently displayed. This is an informational signal, not a guaranteed profit or investment recommendation.`,
    reasons,
    nextStep: tone === "caution" ? "Refresh the data before trading." : "Open the asset, request a fresh quote, and run the pre-check before wallet approval.",
    tone,
  };
}

function modelConfig() {
  const apiKey = process.env.WOLV_AI_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.WOLV_AI_BASE_URL ?? process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.WOLV_AI_MODEL ?? "gpt-5-mini";
  return apiKey ? { apiKey, baseUrl, model } : null;
}

async function modelAnalysis(input: AnalysisInput) {
  const config = modelConfig();
  if (!config) return null;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "You are WOLV AI, a cautious market explainer for non-technical users. Use only the supplied data. Never promise profit, invent prices, give personalized financial advice, or recommend signing without a fresh quote and simulation. Return JSON with headline, summary, reasons (array of short strings), nextStep, and tone (positive, caution, or neutral).",
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "wolv_market_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              headline: { type: "string" },
              summary: { type: "string" },
              reasons: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
              nextStep: { type: "string" },
              tone: { type: "string", enum: ["positive", "caution", "neutral"] },
            },
            required: ["headline", "summary", "reasons", "nextStep", "tone"],
            additionalProperties: false,
          },
        },
      },
      max_completion_tokens: 500,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`AI analysis returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const content = isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0]) && isRecord(payload.choices[0].message)
    ? payload.choices[0].message.content
    : null;
  if (typeof content !== "string") throw new Error("AI analysis returned no text");
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || typeof parsed.headline !== "string" || typeof parsed.summary !== "string" || !Array.isArray(parsed.reasons) || typeof parsed.nextStep !== "string") {
    throw new Error("AI analysis returned an invalid shape");
  }
  return {
    source: "WOLV AI",
    headline: parsed.headline.slice(0, 160),
    summary: parsed.summary.slice(0, 500),
    reasons: parsed.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 4).map((reason) => reason.slice(0, 220)),
    nextStep: parsed.nextStep.slice(0, 240),
    tone: parsed.tone === "positive" || parsed.tone === "caution" ? parsed.tone : "neutral",
  };
}

export async function POST(request: Request) {
  try {
    const input = parseInput(await request.json());
    if (!input) return NextResponse.json({ error: "Invalid analysis request" }, { status: 400 });
    const fallback = fallbackAnalysis(input);
    try {
      const generated = await modelAnalysis(input);
      return NextResponse.json(generated ?? fallback);
    } catch (error) {
      console.error("WOLV AI analysis unavailable; using rules fallback:", error);
      return NextResponse.json({ ...fallback, source: "WOLV rules · AI unavailable" });
    }
  } catch (error) {
    console.error("WOLV analysis failed:", error);
    return NextResponse.json({ error: "Analysis is temporarily unavailable" }, { status: 502 });
  }
}
