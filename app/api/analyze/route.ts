import { NextResponse } from "next/server";
import { filterSpotEligibleAssets } from "@/lib/compliance";
import { getRWATokenList } from "@/lib/binance";
import { getOpportunityRows } from "@/lib/opportunityMonitor";
import { marketLabel } from "@/lib/opportunityMath";
import { quoteAgeSeconds } from "@/lib/quotes";
import { isRwaAssetListResponse } from "@/lib/rwaAssetResponse";
import { parseRwaAssetRecords } from "@/lib/spotAssets";
import {
  buildRulesAnalysis,
  normalizeModelSummary,
  parseAnalysisRequest,
  readBoundedJson,
  type MarketAnalysisInput,
  type VenueAnalysisInput,
} from "@/lib/marketAnalysis";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 2_048;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_MAX_ENTRIES = 64;

const modelSummaryCache = new Map<string, { summary: string; expiresAt: number }>();
const modelSummaryInFlight = new Map<string, Promise<string | null>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelConfig() {
  const configuredKey = process.env.WOLV_AI_API_KEY ?? process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!configuredKey) return null;
  const configuredBase = process.env.WOLV_AI_BASE_URL ?? process.env.OPENAI_API_BASE;
  const configuredModel = process.env.WOLV_AI_MODEL;
  const looksLikeGroq = configuredKey.startsWith("gsk_") || configuredBase?.includes("api.groq.com") === true || configuredModel?.startsWith("openai/gpt-oss") === true;
  const baseUrl = (looksLikeGroq
    ? (configuredBase && !configuredBase.includes("api.openai.com") ? configuredBase : "https://api.groq.com/openai/v1")
    : configuredBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = configuredModel ?? (looksLikeGroq ? "openai/gpt-oss-120b" : "gpt-5-mini");
  return { apiKey: configuredKey, baseUrl, model, provider: looksLikeGroq ? "groq" : "openai" };
}

function analysisMessages(deterministicRead: ReturnType<typeof buildRulesAnalysis>, input: MarketAnalysisInput) {
  return [
    {
      role: "system",
      content: `You are WOLV, a sharp on-chain market analyst for tokenized stocks on BNB Chain. Turn the structured market data into a 2-3 sentence plain-English explanation a trader can act on immediately.

Rules:
- Lead with the most important fact: the dollar gap if venues are aligned, or the session state if mismatched
- For session mismatches: name which venue is open and which is closed, and explain the spread is a timing artifact
- For aligned venues with a spread: state the dollar gap per share (executablePerShare minus referencePerShare), the percent spread, and whether execution costs are likely to absorb it
- For tight spreads under 0.3%: say the spread is thin and execution costs likely absorb it
- For spreads over 1%: say the gap is meaningful and worth requesting a live quote to verify
- For stale or missing data: say what is missing and why acting on it is risky
- Use the ticker name naturally, never say "this is not financial advice"
- Return ONLY a valid JSON object with two string fields: summary (2-3 sentences) and nextStep (one specific action sentence). No markdown, no preamble.`,
    },
    { role: "user", content: JSON.stringify({
      deterministicAssessment: deterministicRead,
      venues: input.venues.map((v) => ({
        platform: v.platform,
        status: v.status,
        referencePerShare: v.referencePerShare,
        executablePerShare: v.executablePerShare,
        referenceGap: v.referenceGap,
        quoteAgeSeconds: v.quoteAgeSeconds,
        stale: v.stale,
        quoteAvailable: v.quoteAvailable,
        dollarGap: (v.referencePerShare != null && v.executablePerShare != null)
          ? Number((v.executablePerShare - v.referencePerShare).toFixed(2))
          : null,
      })),
      ticker: input.ticker,
      spread: input.spread,
      statusMismatch: input.statusMismatch,
    }) },
  ];
}

function parseModelContent(payload: unknown): string | null {
  const content = isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0]) && isRecord(payload.choices[0].message)
    ? payload.choices[0].message.content
    : null;
  if (typeof content !== "string") return null;
  return content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

async function requestModelSummary(
  config: { apiKey: string; baseUrl: string; model: string; provider: string },
  input: MarketAnalysisInput,
  deterministicRead: ReturnType<typeof buildRulesAnalysis>,
  responseFormat?: { type: "json_object" }
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: analysisMessages(deterministicRead, input),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.2,
      max_tokens: 400,
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
  const parsed = JSON.parse(content);
  const summary = normalizeModelSummary(parsed, JSON.stringify(deterministicRead), input);
  const aiNextStep = typeof parsed.nextStep === "string" && parsed.nextStep.trim().length > 0
    ? parsed.nextStep.trim().slice(0, 200)
    : null;
  return JSON.stringify({ summary, aiNextStep });
}

async function modelAnalysis(input: MarketAnalysisInput, deterministicRead: ReturnType<typeof buildRulesAnalysis>) {
  const config = modelConfig();
  if (!config) return null;
  try {
    // JSON mode is supported by Groq's OpenAI-compatible endpoint and avoids
    // the stricter json_schema compatibility gap on gpt-oss models.
    return await requestModelSummary(config, input, deterministicRead, { type: "json_object" });
  } catch (firstError) {
    const message = firstError instanceof Error ? firstError.message : "";
    if (!/AI provider HTTP 400:/i.test(message) || !/response[_ ]format|json[_ ]object/i.test(message)) {
      throw firstError;
    }
    console.warn("WOLV AI JSON mode failed; retrying without response_format:", firstError);
    return requestModelSummary(config, input, deterministicRead);
  }
}

function modelSnapshotKey(input: MarketAnalysisInput): string {
  return JSON.stringify({
    ticker: input.ticker,
    spread: input.spread,
    statusMismatch: input.statusMismatch,
    statuses: input.statuses,
    venues: input.venues.map(({ platform, status, referencePerShare, executablePerShare, referenceGap, stale, unreliable, quoteAvailable }) => ({
      platform,
      status,
      referencePerShare,
      executablePerShare,
      referenceGap,
      stale,
      unreliable,
      quoteAvailable,
    })),
  });
}

async function cachedModelAnalysis(input: MarketAnalysisInput, deterministicRead: ReturnType<typeof buildRulesAnalysis>) {
  const key = modelSnapshotKey(input);
  const now = Date.now();
  const cached = modelSummaryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.summary;
  if (cached) modelSummaryCache.delete(key);

  const inFlight = modelSummaryInFlight.get(key);
  if (inFlight) return inFlight;

  const pending = modelAnalysis(input, deterministicRead)
    .then((summary) => {
      if (!summary) return null;
      modelSummaryCache.set(key, { summary, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      while (modelSummaryCache.size > MODEL_CACHE_MAX_ENTRIES) {
        const oldest = modelSummaryCache.keys().next().value;
        if (oldest === undefined) break;
        modelSummaryCache.delete(oldest);
      }
      return summary;
    })
    .finally(() => modelSummaryInFlight.delete(key));
  modelSummaryInFlight.set(key, pending);
  return pending;
}

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJson(request, MAX_REQUEST_BYTES);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? "Analysis request is too large" : "Invalid JSON request" },
        { status: parsedBody.status }
      );
    }
    const requestInput = parseAnalysisRequest(parsedBody.value);
    if (!requestInput) return NextResponse.json({ error: "A valid ticker is required" }, { status: 400 });

    const response: unknown = await getRWATokenList();
    if (!isRwaAssetListResponse(response, { allowEmpty: true })) {
      throw new Error("The RWA asset response could not be validated");
    }
    const tokens = filterSpotEligibleAssets(parseRwaAssetRecords(response))
      .filter((token) => token.underlyingTicker.trim().toUpperCase() === requestInput.ticker);
    const [row] = await getOpportunityRows(tokens, 1);
    if (!row) {
      return NextResponse.json({ error: "No supported cross-venue data is available for this ticker" }, { status: 404 });
    }
    const input: MarketAnalysisInput = {
      ticker: row.ticker,
      spread: row.crossVenueSpread,
      statusMismatch: row.statusMismatch,
      statuses: row.statuses,
      venues: row.venues.map((venue): VenueAnalysisInput => ({
        platform: venue.token.platformId,
        status: marketLabel(venue.token),
        referencePerShare: venue.referencePerShare,
        executablePerShare: venue.executablePerShare,
        referenceGap: venue.referenceGap,
        quoteAgeSeconds: quoteAgeSeconds(venue.quote),
        stale: venue.stale,
        unreliable: venue.unreliable,
        quoteAvailable: venue.quote.ok,
      })),
    };
    const fallback = buildRulesAnalysis(input);
    const checkedAt = Date.now();
    try {
      const generatedSummary = await cachedModelAnalysis(input, fallback);
      return NextResponse.json({
        ...fallback,
        ...(generatedSummary ? (() => {
          const parsed = JSON.parse(generatedSummary);
          return {
            source: "WOLV AI paraphrase · rules verified",
            summary: parsed.summary ?? generatedSummary,
            nextStep: parsed.aiNextStep ?? fallback.nextStep,
          };
        })() : { source: "WOLV rules · model not configured" }),
        checkedAt,
        dataSources: ["Binance RWA reference data", "Binance executable quote"],
        observations: input.venues.map((venue) => ({
          platform: venue.platform,
          status: venue.status,
          quoteAvailable: venue.quoteAvailable,
          quoteAgeSeconds: venue.quoteAvailable ? venue.quoteAgeSeconds : null,
          stale: venue.stale,
        })),
      });
    } catch (error) {
      const config = modelConfig();
      console.error("WOLV AI analysis unavailable; using rules fallback:", {
        error,
        configured: Boolean(config),
        baseUrl: config?.baseUrl,
        model: config?.model,
        provider: config?.provider,
      });
      return NextResponse.json({
        ...fallback,
        source: "WOLV rules · AI unavailable",
        checkedAt,
        dataSources: ["Binance RWA reference data", "Binance executable quote"],
        observations: input.venues.map((venue) => ({
          platform: venue.platform,
          status: venue.status,
          quoteAvailable: venue.quoteAvailable,
          quoteAgeSeconds: venue.quoteAvailable ? venue.quoteAgeSeconds : null,
          stale: venue.stale,
        })),
      });
    }
  } catch (error) {
    console.error("WOLV analysis failed:", error);
    return NextResponse.json({ error: "Analysis is temporarily unavailable" }, { status: 502 });
  }
}
