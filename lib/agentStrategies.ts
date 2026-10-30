export type AgentStrategy = {
  ticker: string;
  side: "buy" | "sell";
  amount: string;
  amountUnit: "BNB" | "token";
  triggerPercent: number;
  triggerDirection: "drop" | "rise";
  maxSlippagePercent: number;
};

export type StrategyParseResult =
  | { ok: true; strategy: AgentStrategy }
  | { ok: false; error: string };

export type MockTriggerResult =
  | { ok: true; triggered: boolean; changePercent: number }
  | { ok: false; error: string };

const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const MAX_STRATEGY_BNB = 10;

function parseDecimal(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNaturalLanguage(input: string): StrategyParseResult {
  const match = input.match(
    /^\s*(?:auto-swap|buy)\s+(\d+(?:\.\d+)?)\s+bnb\s+into\s+([a-z0-9][a-z0-9.-]{0,9})(?:\s+tokenized stock)?\s+when\s+(?:the\s+)?price\s+(?:drops?|falls?)\s+(?:by\s+)?(\d+(?:\.\d+)?)%(?:\s+max\s+slippage\s+(\d+(?:\.\d+)?)%)?\s*$/i
  );
  if (!match) {
    return {
      ok: false,
      error: "Use a supported buy rule such as: Auto-swap 0.1 BNB into AAPL tokenized stock when price drops 2%.",
    };
  }

  return validateStrategy({
    ticker: match[2],
    side: "buy",
    amountBnb: match[1],
    triggerPercent: match[3],
    triggerDirection: "drop",
    maxSlippagePercent: match[4] ?? "0.5",
  });
}

function validateStrategy(input: Record<string, unknown>): StrategyParseResult {
  const ticker = typeof input.ticker === "string"
    ? input.ticker.trim().toUpperCase()
    : typeof input.targetTicker === "string"
      ? input.targetTicker.trim().toUpperCase()
      : "";
  if (!TICKER_PATTERN.test(ticker)) {
    return { ok: false, error: "Ticker must be 1–10 letters, numbers, dots, or hyphens." };
  }

  const side = input.side;
  if (side !== "buy" && side !== "sell") {
    return { ok: false, error: "Side must be buy or sell." };
  }

  const amountUnit = side === "buy" ? "BNB" : "token";
  const amountValue = side === "buy"
    ? input.amountBnb ?? (input.amountUnit === "BNB" ? input.amount : undefined)
    : input.amountToken ?? (input.amountUnit === "token" ? input.amount : undefined);
  const amountText = typeof amountValue === "string" || typeof amountValue === "number"
    ? String(amountValue).trim()
    : "";
  const amount = parseDecimal(amountText);
  const maximumAmount = side === "buy" ? MAX_STRATEGY_BNB : 1_000_000_000;
  if (amount === null || amount <= 0 || amount > maximumAmount) {
    const unitLabel = side === "buy" ? " BNB" : " tokens";
    return { ok: false, error: `Amount must be greater than 0 and no more than ${maximumAmount}${unitLabel}.` };
  }

  const triggerPercent = parseDecimal(input.triggerPercent);
  if (triggerPercent === null || triggerPercent <= 0 || triggerPercent > 100) {
    return { ok: false, error: "Trigger percentage must be greater than 0 and no more than 100." };
  }

  const maxSlippagePercent = parseDecimal(input.maxSlippagePercent);
  if (maxSlippagePercent === null || maxSlippagePercent < 0 || maxSlippagePercent > 5) {
    return { ok: false, error: "Maximum slippage must be between 0 and 5 percent." };
  }

  return {
    ok: true,
    strategy: {
      ticker,
      side,
      amount: amountText,
      amountUnit,
      triggerPercent,
      triggerDirection: side === "buy" ? "drop" : "rise",
      maxSlippagePercent,
    },
  };
}

export function parseAgentStrategy(input: unknown): StrategyParseResult {
  if (typeof input === "string") return parseNaturalLanguage(input);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Provide a strategy sentence or structured strategy fields." };
  }
  return validateStrategy(input as Record<string, unknown>);
}

export function evaluateMockTrigger(
  strategy: AgentStrategy,
  referencePrice: unknown,
  currentPrice: unknown
): MockTriggerResult {
  const reference = parseDecimal(referencePrice);
  const current = parseDecimal(currentPrice);
  if (reference === null || current === null || reference <= 0 || current <= 0) {
    return { ok: false, error: "Reference and current prices must be positive finite numbers." };
  }

  const changePercent = ((current - reference) / reference) * 100;
  const triggered = strategy.triggerDirection === "drop"
    ? changePercent <= -strategy.triggerPercent
    : changePercent >= strategy.triggerPercent;

  return { ok: true, triggered, changePercent };
}
