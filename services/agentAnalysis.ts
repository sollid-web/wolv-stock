import "server-only";

export type AgentAnalysisInput = {
  ticker: string;
  opportunity: {
    spreadPercent: number;
    reason: string;
    evidenceIds: string[];
  };
  observations: Array<{
    observationId: string;
    platform: string;
    price: string;
    currency: string;
    providerTimestamp: string | number;
    verificationStatus: string;
    priceKind: string;
  }>;
  historicalContext: Array<{
    observationId: string;
    price: string;
    source: string;
    providerTimestamp: string | number;
  }>;
  strategyConfiguration: Record<string, unknown>;
  dataFresh: boolean;
};

export type AgentAnalysisResult = {
  modelIdentifier: string;
  modelVersion: string | null;
  interpretation: string;
  opportunityExplanation: string;
  historicalComparison: string;
  upsideScenario: string;
  downsideScenario: string;
  risks: string[];
  dataLimitations: string[];
  invalidatingConditions: string[];
  suggestedNextAction: string;
  evidenceReferences: string[];
  assumptions: string[];
};

export interface AgentAnalysisProvider {
  analyze(input: AgentAnalysisInput): Promise<AgentAnalysisResult>;
}

type ModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
};

export class AgentAnalysisError extends Error {
  readonly code: "MODEL_NOT_CONFIGURED" | "MODEL_UNAVAILABLE" | "INVALID_ANALYSIS";

  constructor(
    code: AgentAnalysisError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "AgentAnalysisError";
  }
}

export class ConfiguredAgentAnalysisProvider implements AgentAnalysisProvider {
  private readonly config: ModelConfig | null;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    config = resolveModelConfig(),
    fetchImplementation: typeof fetch = fetch,
    timeoutMs = 5_000,
  ) {
    this.config = config;
    this.fetchImplementation = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async analyze(input: AgentAnalysisInput): Promise<AgentAnalysisResult> {
    if (!this.config) {
      throw new AgentAnalysisError("MODEL_NOT_CONFIGURED", "No server-side AI analysis provider is configured.");
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Provide a concise, evidence-based market interpretation, not hidden chain-of-thought.",
                "Return only JSON with interpretation, opportunityExplanation, historicalComparison, upsideScenario, downsideScenario, risks, dataLimitations, invalidatingConditions, suggestedNextAction, evidenceReferences, assumptions.",
                "Use only facts present in the evidence. Treat price differences as uncertain, not guaranteed profit.",
                "Do not give permission, override policies, claim calibrated probabilities, or recommend automatic execution.",
                "Return evidenceReferences only from supplied observation IDs.",
              ].join(" "),
            },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AgentAnalysisError("MODEL_UNAVAILABLE", "Configured analysis provider could not be reached.");
    }
    if (!response.ok) {
      throw new AgentAnalysisError("MODEL_UNAVAILABLE", `Configured analysis provider returned HTTP ${response.status}.`);
    }
    const payload: unknown = await readJson(response);
    const content = readModelContent(payload);
    if (!content) throw new AgentAnalysisError("INVALID_ANALYSIS", "Analysis provider returned no structured content.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      throw new AgentAnalysisError("INVALID_ANALYSIS", "Analysis provider returned malformed structured content.");
    }
    return validateAnalysis(decoded, input, this.config.model);
  }
}

export function validateAnalysis(
  value: unknown,
  input: AgentAnalysisInput,
  modelIdentifier: string,
): AgentAnalysisResult {
  if (!isRecord(value)) throw new AgentAnalysisError("INVALID_ANALYSIS", "Analysis output must be an object.");
  const allowedEvidence = new Set([
    ...input.opportunity.evidenceIds,
    ...input.historicalContext.map((entry) => entry.observationId),
  ]);
  const evidenceReferences = stringArray(value.evidenceReferences, "evidenceReferences");
  if (!evidenceReferences.length || evidenceReferences.some((id) => !allowedEvidence.has(id))) {
    throw new AgentAnalysisError("INVALID_ANALYSIS", "Analysis cited evidence that was not supplied.");
  }
  const risks = stringArray(value.risks, "risks");
  const dataLimitations = stringArray(value.dataLimitations, "dataLimitations");
  const invalidatingConditions = stringArray(value.invalidatingConditions, "invalidatingConditions");
  const assumptions = stringArray(value.assumptions, "assumptions");
  return {
    modelIdentifier,
    modelVersion: null,
    interpretation: requiredText(value.interpretation, "interpretation"),
    opportunityExplanation: requiredText(value.opportunityExplanation, "opportunityExplanation"),
    historicalComparison: requiredText(value.historicalComparison, "historicalComparison"),
    upsideScenario: requiredText(value.upsideScenario, "upsideScenario"),
    downsideScenario: requiredText(value.downsideScenario, "downsideScenario"),
    risks,
    dataLimitations,
    invalidatingConditions,
    suggestedNextAction: requiredText(value.suggestedNextAction, "suggestedNextAction"),
    evidenceReferences: [...new Set(evidenceReferences)],
    assumptions,
  };
}

function resolveModelConfig(): ModelConfig | null {
  const apiKey = process.env.WOLV_AI_API_KEY ?? process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const configuredBase = process.env.WOLV_AI_BASE_URL ?? process.env.OPENAI_API_BASE;
  const configuredModel = process.env.WOLV_AI_MODEL;
  const looksLikeGroq = apiKey.startsWith("gsk_") ||
    configuredBase?.includes("api.groq.com") === true ||
    configuredModel?.startsWith("openai/gpt-oss") === true;
  return {
    apiKey,
    baseUrl: (looksLikeGroq
      ? configuredBase && !configuredBase.includes("api.openai.com")
        ? configuredBase
        : "https://api.groq.com/openai/v1"
      : configuredBase ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    model: configuredModel ?? (looksLikeGroq ? "openai/gpt-oss-120b" : "gpt-5-mini"),
    provider: looksLikeGroq ? "groq" : "openai",
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new AgentAnalysisError("INVALID_ANALYSIS", "Analysis provider returned invalid JSON.");
  }
}

function readModelContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices) ||
    !isRecord(value.choices[0]) || !isRecord(value.choices[0].message) ||
    typeof value.choices[0].message.content !== "string") return null;
  return value.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) {
    throw new AgentAnalysisError("INVALID_ANALYSIS", `Analysis field ${field} is invalid.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 20 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 500)) {
    throw new AgentAnalysisError("INVALID_ANALYSIS", `Analysis field ${field} is invalid.`);
  }
  return value.map((entry) => (entry as string).trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
