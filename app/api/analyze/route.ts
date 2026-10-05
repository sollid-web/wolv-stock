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
  const groqKey = process.env.GROQ_API_KEY;
  const apiKey = process.env.WOLV_AI_API_KEY ?? groqKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.WOLV_AI_BASE_URL ?? (groqKey ? "https://api.groq.com/openai/v1" : process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1")).replace(/\/$/, "");
  const model = process.env.WOLV_AI_MODEL ?? (groqKey ? "openai/gpt-oss-120b" : "gpt-5-mini");
  return apiKey ? { apiKey, baseUrl, model } : null;
}

function analysisMessages(input: AnalysisInput) {
  return [
    {
      role: "system",
      content: "You are WOLV AI, a cautious market explainer for non-technical users. Use only the supplied data. Never promise profit, invent prices, give personalized financial advice, or recommend signing without a fresh quote and simulation. Return ONLY one valid JSON object, with no markdown fences and no additional text. The object must contain: headline (string), summary (string), reasons (array of 1 to 4 short strings), nextStep (string), and tone (exactly one of positive, caution, neutral).",
    },
    { role: "user", content: JSON.stringify(input) },
  ];
}

function parseModelContent(payload: unknown): string | null {
  const content = isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0]) && isRecord(payload.choices[0].message)
    ? payload.choices[0].message.content
    : null;
  if (typeof content !== "string") return null;
  return content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function normalizeModelResult(parsed: unknown) {
  if (!isRecord(parsed) || typeof parsed.headline !== "string" || typeof parsed.summary !== "string" || !Array.isArray(parsed.reasons) || typeof parsed.nextStep !== "string") {
    throw new Error("AI analysis returned an invalid JSON shape");
  }
  const reasons = parsed.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 4).map((reason) => reason.slice(0, 220));
  if (reasons.length === 0) throw new Error("AI analysis returned no reasons");
  return {
    source: "WOLV AI",
    headline: parsed.headline.slice(0, 160),
    summary: parsed.summary.slice(0, 500),
    reasons,
    nextStep: parsed.nextStep.slice(0, 240),
    tone: parsed.tone === "positive" || parsed.tone === "caution" ? parsed.tone : "neutral",
  } as const;
}

async function requestModel(config: { apiKey: string; baseUrl: string; model: string }, input: AnalysisInput, responseFormat?: { type: "json_object" }) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: analysisMessages(input),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.2,
      max_tokens: 700,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${responseText.slice(0, 240)}`);
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }
  const content = parseModelContent(payload);
  if (!content) throw new Error("AI provider returned no message content");
  return normalizeModelResult(JSON.parse(content));
}

async function modelAnalysis(input: AnalysisInput) {
  const config = modelConfig();
  if (!config) return null;
  try {
    // JSON mode is supported by Groq's OpenAI-compatible endpoint and avoids
    // the stricter json_schema compatibility gap on gpt-oss models.
    return await requestModel(config, input, { type: "json_object" });
  } catch (firstError) {
    // Some OpenAI-compatible gateways reject response_format entirely; retry
    // once with the explicit JSON-only prompt before using the safe fallback.
    console.warn("WOLV AI JSON mode failed; retrying without response_format:", firstError);
    return requestModel(config, input);
  }
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
      const config = modelConfig();
      console.error("WOLV AI analysis unavailable; using rules fallback:", {
        error,
        configured: Boolean(config),
        baseUrl: config?.baseUrl,
        model: config?.model,
      });
      return NextResponse.json({ ...fallback, source: "WOLV rules · AI unavailable" });
    }
  } catch (error) {
    console.error("WOLV analysis failed:", error);
    return NextResponse.json({ error: "Analysis is temporarily unavailable" }, { status: 502 });
  }
}
