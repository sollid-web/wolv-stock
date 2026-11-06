import "server-only";
import type { UsMarketCalendarDay } from "./usMarketCalendar.ts";

export const BSC_MAINNET_CHAIN_ID = 56;
export const BINANCE_DELEGATED_CUSTODY_CHAIN_ID = 97;
export const WEEKEND_DEFI_CALENDAR_MAX_AGE_MS = 6 * 60 * 60_000;
export const WEEKEND_DEFI_ASSET_CAPS = ["SPY", "QQQ", "NVDA", "ORCL"] as const;

export type WeekendDefiConfig = {
  protocolId: string;
  investmentId: string;
  allocationAmount: string;
  maxPerDeposit: string;
  maxAssetAllocation: string;
  maxTotalAllocation: string;
  riskCapBps: number;
  investmentRiskBps: number;
  guardTicker: typeof WEEKEND_DEFI_ASSET_CAPS[number] | null;
};

export type WeekendDefiAction = "DEPOSIT" | "REDEEM";

export type WeekendDefiDecision = {
  allowed: boolean;
  action: WeekendDefiAction;
  calendarDate: string;
  marketSession: UsMarketCalendarDay["session"];
  marketClosedAtEvaluation: boolean;
  warnings: string[];
  blockers: string[];
  automaticExecution: false;
  transactionSubmitted: false;
  chainId: typeof BSC_MAINNET_CHAIN_ID;
};

export type AsyncRedemptionRequest = {
  status: "ASYNC_REQUEST_PREPARED";
  requestedAt: number;
  redeemDelayDays: [string, string] | [];
  earliestExpectedAt: number | null;
  latestExpectedAt: number | null;
  guaranteedLiquidByMarketOpen: false;
  warnings: string[];
};

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/;
const INVESTMENT_ID = /^[a-fA-F0-9]{64}$/;
const PROTOCOL_ID = /^[a-zA-Z0-9._-]{1,128}$/;

export function parseWeekendDefiConfig(value: unknown): WeekendDefiConfig {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "protocolId",
    "investmentId",
    "allocationAmount",
    "maxPerDeposit",
    "maxAssetAllocation",
    "maxTotalAllocation",
    "riskCapBps",
    "investmentRiskBps",
    "guardTicker",
  ].includes(key))) {
    throw new TypeError("Weekend DeFi strategy configuration is invalid.");
  }
  const {
    protocolId,
    investmentId,
    allocationAmount,
    maxPerDeposit,
    maxAssetAllocation,
    maxTotalAllocation,
    riskCapBps,
    investmentRiskBps,
    guardTicker,
  } = value;
  if (typeof protocolId !== "string" || !PROTOCOL_ID.test(protocolId) ||
    typeof investmentId !== "string" || !INVESTMENT_ID.test(investmentId) ||
    !isPositiveDecimal(allocationAmount) ||
    !isPositiveDecimal(maxPerDeposit) ||
    !isPositiveDecimal(maxAssetAllocation) ||
    !isPositiveDecimal(maxTotalAllocation) ||
    typeof riskCapBps !== "number" || !Number.isInteger(riskCapBps) ||
    riskCapBps < 0 || riskCapBps > 10_000 ||
    typeof investmentRiskBps !== "number" || !Number.isInteger(investmentRiskBps) ||
    investmentRiskBps < 0 || investmentRiskBps > riskCapBps ||
    (guardTicker !== null && guardTicker !== undefined &&
      !(WEEKEND_DEFI_ASSET_CAPS as readonly string[]).includes(String(guardTicker)))) {
    throw new TypeError("Weekend DeFi policy fields must contain valid investment, allocation, and risk bounds.");
  }

  const allocation = decimalUnits(allocationAmount);
  if (allocation > decimalUnits(maxPerDeposit) ||
    decimalUnits(maxPerDeposit) > decimalUnits(maxAssetAllocation) ||
    decimalUnits(maxAssetAllocation) > decimalUnits(maxTotalAllocation)) {
    throw new TypeError("Weekend DeFi allocation must fit within per-deposit, asset, and total allocation caps.");
  }

  return {
    protocolId,
    investmentId,
    allocationAmount,
    maxPerDeposit,
    maxAssetAllocation,
    maxTotalAllocation,
    riskCapBps,
    investmentRiskBps,
    guardTicker: guardTicker == null ? null : guardTicker as WeekendDefiConfig["guardTicker"],
  };
}

export function evaluateWeekendDefiPlan(input: {
  config: WeekendDefiConfig;
  action: WeekendDefiAction;
  currentCalendar: UsMarketCalendarDay;
  previousCalendar?: UsMarketCalendarDay | null;
  now: number;
  sessionMismatch?: boolean;
}): WeekendDefiDecision {
  const { config, action, currentCalendar, previousCalendar, now } = input;
  const blockers: string[] = [];
  const marketClosedAtEvaluation = isMarketClosedAt(currentCalendar, now);
  const warnings = [
    "This endpoint prepares unsigned transaction data only; the user must review and sign in their wallet.",
  ];

  if (!isFreshCalendarDay(currentCalendar, now)) {
    blockers.push("Fresh verified US market calendar evidence is required.");
  }
  if (action === "DEPOSIT" && !marketClosedAtEvaluation) {
    blockers.push("A DeFi deposit preview requires verified market-closed calendar evidence.");
  }
  if (action === "REDEEM") {
    if (!isFreshCalendarDay(previousCalendar, now) || !isMarketClosedAt(previousCalendar, now)) {
      blockers.push("A redemption request requires a verified closed-to-open calendar transition.");
    }
    if (marketClosedAtEvaluation || !isMarketOpenAt(currentCalendar, now)) {
      blockers.push("A redemption request requires the current verified market session to be open.");
    }
  }
  if (config.investmentRiskBps > config.riskCapBps) {
    blockers.push("The investment risk score exceeds the user-approved risk cap.");
  }
  if (input.sessionMismatch === true) {
    warnings.push("A market-pulse session mismatch is present; it is a warning/veto signal, not evidence that the traditional market is closed.");
  }

  return {
    allowed: blockers.length === 0,
    action,
    calendarDate: currentCalendar.date,
    marketSession: currentCalendar.session,
    marketClosedAtEvaluation,
    warnings,
    blockers,
    automaticExecution: false,
    transactionSubmitted: false,
    chainId: BSC_MAINNET_CHAIN_ID,
  };
}

export function isWeekendDefiAmountWithinCaps(config: WeekendDefiConfig, amount: string): boolean {
  if (!isPositiveDecimal(amount)) return false;
  const amountValue = decimalUnits(amount);
  return amountValue <= decimalUnits(config.allocationAmount) &&
    amountValue <= decimalUnits(config.maxPerDeposit) &&
    amountValue <= decimalUnits(config.maxAssetAllocation) &&
    amountValue <= decimalUnits(config.maxTotalAllocation);
}

export function createAsyncRedemptionRequest(input: {
  requestedAt: number;
  redeemDelayDays: [string, string] | [];
  providerWarnings: Array<{ code: string; level: string; message: string }>;
}): AsyncRedemptionRequest {
  if (!Number.isSafeInteger(input.requestedAt) || input.requestedAt <= 0 ||
    !Array.isArray(input.redeemDelayDays) ||
    (input.redeemDelayDays.length !== 0 && input.redeemDelayDays.length !== 2) ||
    !input.redeemDelayDays.every((day) => /^\d{1,4}$/.test(day))) {
    throw new TypeError("DeFi redemption scheduling metadata is invalid.");
  }
  const warnings = [
    ...input.providerWarnings.map((warning) => warning.message),
    "Redemption is an asynchronous request. Settlement may be delayed and is not guaranteed to be liquid by traditional market open.",
  ];
  const delayRange = input.redeemDelayDays.map(Number);
  if (delayRange.length === 2 && delayRange[0] > delayRange[1]) {
    throw new TypeError("DeFi redemption delay range is invalid.");
  }
  if (delayRange.length === 2 && delayRange[0] <= delayRange[1]) {
    return {
      status: "ASYNC_REQUEST_PREPARED",
      requestedAt: input.requestedAt,
      redeemDelayDays: input.redeemDelayDays,
      earliestExpectedAt: input.requestedAt + delayRange[0] * 24 * 60 * 60_000,
      latestExpectedAt: input.requestedAt + delayRange[1] * 24 * 60 * 60_000,
      guaranteedLiquidByMarketOpen: false,
      warnings,
    };
  }
  return {
    status: "ASYNC_REQUEST_PREPARED",
    requestedAt: input.requestedAt,
    redeemDelayDays: input.redeemDelayDays,
    earliestExpectedAt: null,
    latestExpectedAt: null,
    guaranteedLiquidByMarketOpen: false,
    warnings,
  };
}

export function isMainnetAutonomousDefiBlocked(input: {
  chainId: number;
  delegatedPolicyChainId: number | null;
}): boolean {
  return input.chainId === BSC_MAINNET_CHAIN_ID ||
    input.delegatedPolicyChainId !== BINANCE_DELEGATED_CUSTODY_CHAIN_ID;
}

export function marketCalendarDateInNewYork(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Could not derive the US market calendar date.");
  return `${year}-${month}-${day}`;
}

export function previousCalendarDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Market calendar date is invalid.");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError("Market calendar date is invalid.");
  }
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function isFreshCalendarDay(
  value: UsMarketCalendarDay | null | undefined,
  now: number,
): value is UsMarketCalendarDay {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    !["OPEN", "CLOSED", "EARLY_CLOSE"].includes(value.session)) return false;
  const parsedDate = new Date(`${value.date}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value.date) return false;
  const sessionStart = value.sessionStartUtcMinutes;
  const sessionEnd = value.sessionEndUtcMinutes;
  if (value.session !== "CLOSED" &&
    (typeof sessionStart !== "number" || !Number.isInteger(sessionStart) ||
      typeof sessionEnd !== "number" || !Number.isInteger(sessionEnd) ||
      sessionStart < 0 || sessionStart >= 1440 ||
      sessionEnd <= 0 || sessionEnd > 1440 || sessionEnd <= sessionStart)) return false;
  const providerTimestamp = Date.parse(value.providerTimestamp);
  return Number.isFinite(providerTimestamp) &&
    Math.abs(now - providerTimestamp) <= WEEKEND_DEFI_CALENDAR_MAX_AGE_MS;
}

function isMarketClosedAt(value: UsMarketCalendarDay, now: number): boolean {
  return value.session === "CLOSED" || !isMarketOpenAt(value, now);
}

function isMarketOpenAt(value: UsMarketCalendarDay, now: number): boolean {
  if (value.session === "CLOSED") return false;
  const sessionStart = calendarSessionTimestamp(value.date, value.sessionStartUtcMinutes);
  const sessionEnd = calendarSessionTimestamp(value.date, value.sessionEndUtcMinutes);
  return sessionStart !== null && sessionEnd !== null && now >= sessionStart && now < sessionEnd;
}

function calendarSessionTimestamp(date: string, utcMinutes: number | undefined): number | null {
  if (!Number.isInteger(utcMinutes) || utcMinutes === undefined ||
    utcMinutes < 0 || utcMinutes >= 1440 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const dateStart = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(dateStart)) return null;
  return dateStart + utcMinutes * 60_000;
}

function isPositiveDecimal(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) return false;
  return decimalUnits(value) > BigInt(0);
}

function decimalUnits(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) {
    throw new TypeError("Allocation amount is invalid.");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * (BigInt(10) ** BigInt(18)) + BigInt(fraction.padEnd(18, "0"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
