import "server-only";

export type UsMarketCalendarDay = {
  date: string;
  session: "OPEN" | "CLOSED" | "EARLY_CLOSE";
  sessionStartUtcMinutes?: number;
  sessionEndUtcMinutes?: number;
  providerTimestamp: string;
};

export class UsMarketCalendarError extends Error {
  readonly code: "NOT_CONFIGURED" | "UNAVAILABLE" | "MALFORMED" | "STALE";
  constructor(code: "NOT_CONFIGURED" | "UNAVAILABLE" | "MALFORMED" | "STALE", message: string) {
    super(message);
    this.name = "UsMarketCalendarError";
    this.code = code;
  }
}

export async function fetchVerifiedUsMarketCalendar(date: string, now = Date.now(), fetchImpl = fetch) {
  const url = process.env.WOLV_US_MARKET_CALENDAR_URL?.trim();
  if (!url || !/^https:\/\//i.test(url)) throw new UsMarketCalendarError("NOT_CONFIGURED", "A verified HTTPS US market calendar provider is required.");
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new UsMarketCalendarError("UNAVAILABLE", "The verified US market calendar provider is unavailable.");
  }
  if (!response.ok) throw new UsMarketCalendarError("UNAVAILABLE", "The verified US market calendar provider returned an error.");
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new UsMarketCalendarError("MALFORMED", "The market calendar response is not valid JSON."); }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { days?: unknown }).days)) {
    throw new UsMarketCalendarError("MALFORMED", "The market calendar response schema is invalid.");
  }
  const day = (payload as { days: unknown[] }).days.find((item) =>
    item && typeof item === "object" && (item as { date?: unknown }).date === date) as Partial<UsMarketCalendarDay> | undefined;
  if (!day || !["OPEN", "CLOSED", "EARLY_CLOSE"].includes(String(day.session)) ||
    typeof day.providerTimestamp !== "string") {
    throw new UsMarketCalendarError("MALFORMED", "The requested date is missing or malformed.");
  }
  const providerTime = Date.parse(day.providerTimestamp);
  if (!Number.isFinite(providerTime) || Math.abs(now - providerTime) > 24 * 60 * 60_000) {
    throw new UsMarketCalendarError("STALE", "The verified market calendar data is stale.");
  }
  if (day.session === "OPEN" || day.session === "EARLY_CLOSE") {
    if (!Number.isInteger(day.sessionStartUtcMinutes) || !Number.isInteger(day.sessionEndUtcMinutes) ||
      (day.sessionStartUtcMinutes ?? -1) < 0 || (day.sessionStartUtcMinutes ?? 1441) >= 1440 ||
      (day.sessionEndUtcMinutes ?? 0) <= 0 || (day.sessionEndUtcMinutes ?? 1440) > 1440 ||
      (day.sessionEndUtcMinutes ?? 0) <= (day.sessionStartUtcMinutes ?? -1)) {
      throw new UsMarketCalendarError("MALFORMED", "The market session times are malformed.");
    }
  }
  return {
    date,
    session: day.session as "OPEN" | "CLOSED" | "EARLY_CLOSE",
    sessionStartUtcMinutes: day.sessionStartUtcMinutes,
    sessionEndUtcMinutes: day.sessionEndUtcMinutes,
    providerTimestamp: day.providerTimestamp,
  } satisfies UsMarketCalendarDay;
}
