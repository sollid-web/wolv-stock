import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import {
  fetchVerifiedUsMarketCalendar,
  type UsMarketCalendarDay,
} from "@/services/usMarketCalendar";
import {
  isWeekendDefiAmountWithinCaps,
  marketCalendarDateInNewYork,
  parseWeekendDefiConfig,
  previousCalendarDate,
  type WeekendDefiAction,
  type WeekendDefiConfig,
} from "@/services/weekendDefiRebalancer";

export const WEEKEND_DEFI_HEADERS = { "Cache-Control": "no-store" };
export const WEEKEND_DEFI_MAX_BODY_BYTES = 8_192;
export const SCHEDULE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WeekendDefiSchedule = {
  scheduleId: string;
  name: string;
  enabled: boolean;
  strategyType: string;
  executionMode: string;
  strategyConfig: WeekendDefiConfig;
  policyHash: string;
  intervalSeconds: number;
  nextRunAt: number;
};

export type MarketPulseGuard = {
  sessionMismatch: boolean;
  stale: boolean;
};

export async function authorizeWeekendDefiRequest(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const authorization = await authorizeBawWalletRequest(request, token);
  if (authorization !== "authorized") {
    return {
      error: authorization === "not_configured"
        ? jsonError("Wallet session access is not configured.", 503)
        : jsonError("A valid wallet session authorization is required.", 401),
      session: null,
    };
  }
  try {
    const session = await getBawWalletSession(request, token);
    if (!session) {
      return { error: jsonError("A connected wallet session is required.", 401), session: null };
    }
    return { error: null, session };
  } catch {
    return { error: jsonError("Wallet session verification is temporarily unavailable.", 503), session: null };
  }
}

export async function readWeekendDefiRequestBody(request: Request): Promise<
  { body: Record<string, unknown>; error: null } | { body: null; error: Response }
> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { body: null, error: jsonError("Content-Type must be application/json.", 400) };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > WEEKEND_DEFI_MAX_BODY_BYTES)) {
    return { body: null, error: jsonError("Weekend DeFi request exceeds the 8 KB limit.", 413) };
  }
  let text: string;
  try {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > WEEKEND_DEFI_MAX_BODY_BYTES) {
      return { body: null, error: jsonError("Weekend DeFi request exceeds the 8 KB limit.", 413) };
    }
  } catch {
    return { body: null, error: jsonError("Weekend DeFi request could not be read.", 400) };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { body: null, error: jsonError("Request body must be an object.", 422) };
    return { body: value, error: null };
  } catch {
    return { body: null, error: jsonError("Request body must contain valid JSON.", 400) };
  }
}

export async function loadWeekendDefiSchedule(input: {
  store: AgentMemoryStore;
  ownerAddress: string;
  scheduleId: unknown;
}): Promise<WeekendDefiSchedule | null> {
  if (typeof input.scheduleId !== "string" || !SCHEDULE_ID_PATTERN.test(input.scheduleId)) return null;
  const schedules = await input.store.listSchedules(input.ownerAddress, 100);
  const schedule = schedules.find((item) => item.scheduleId === input.scheduleId);
  if (!schedule) return null;
  if (schedule.strategyType !== "WEEKEND_DEFI" ||
    (schedule.executionMode !== "MANUAL" && schedule.executionMode !== "AUTONOMOUS")) {
    return null;
  }
  return {
    scheduleId: String(schedule.scheduleId),
    name: String(schedule.name),
    enabled: schedule.enabled === true,
    strategyType: String(schedule.strategyType),
    executionMode: String(schedule.executionMode),
    strategyConfig: parseWeekendDefiConfig(schedule.strategyConfig),
    policyHash: String(schedule.policyHash),
    intervalSeconds: Number(schedule.intervalSeconds),
    nextRunAt: Number(schedule.nextRunAt),
  };
}

export async function fetchWeekendDefiCalendarTransition(now: number): Promise<{
  current: UsMarketCalendarDay;
  previous: UsMarketCalendarDay;
}> {
  const date = marketCalendarDateInNewYork(now);
  const priorDate = previousCalendarDate(date);
  const [current, previous] = await Promise.all([
    fetchVerifiedUsMarketCalendar(date, now),
    fetchVerifiedUsMarketCalendar(priorDate, now),
  ]);
  return { current, previous };
}

export async function readMarketPulseGuard(ticker: WeekendDefiConfig["guardTicker"]): Promise<MarketPulseGuard> {
  if (!ticker) return { sessionMismatch: false, stale: false };
  const { data, error } = await getSupabaseAdminClient()
    .from("tokenized_market_pulse")
    .select("session_mismatch, updated_at")
    .eq("ticker", ticker)
    .maybeSingle();
  if (error) throw new Error("Market-pulse warning status could not be read.");
  if (!data || typeof data.session_mismatch !== "boolean" ||
    typeof data.updated_at !== "string") {
    throw new Error("Market-pulse warning status is missing or malformed.");
  }
  const updatedAt = Date.parse(data.updated_at);
  if (!Number.isFinite(updatedAt)) throw new Error("Market-pulse timestamp is malformed.");
  return {
    sessionMismatch: data.session_mismatch,
    stale: Date.now() - updatedAt > 120_000 || updatedAt > Date.now() + 30_000,
  };
}

export function validateWeekendDefiRequest(input: {
  walletAddress: unknown;
  sessionAddress: string;
  schedule: WeekendDefiSchedule;
  investmentId: unknown;
  amount: unknown;
  action: WeekendDefiAction;
}): { amount: string; investmentId: string } | Response {
  if (typeof input.walletAddress !== "string" ||
    !/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress) ||
    input.walletAddress.toLowerCase() !== input.sessionAddress.toLowerCase()) {
    return jsonError("The requested wallet must match the authenticated wallet session.", 403);
  }
  if (!input.schedule.enabled) return jsonError("The Weekend DeFi strategy is not active.", 409);
  if (input.schedule.executionMode !== "MANUAL") {
    return jsonError("Weekend DeFi mainnet transaction building is manual-only.", 403, {
      execution: "BLOCKED",
      chainId: 56,
    });
  }
  if (typeof input.investmentId !== "string" ||
    input.investmentId.toLowerCase() !== input.schedule.strategyConfig.investmentId.toLowerCase() ||
    typeof input.amount !== "string" ||
    !isWeekendDefiAmountWithinCaps(input.schedule.strategyConfig, input.amount)) {
    return jsonError("Investment ID or amount does not match the active owner-scoped strategy limits.", 422);
  }
  return {
    investmentId: input.investmentId,
    amount: input.amount,
  };
}

export function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ error: message, ...extra }, {
    status,
    headers: WEEKEND_DEFI_HEADERS,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
