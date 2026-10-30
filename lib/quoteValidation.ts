import { MAX_RELIABLE_GAP_PERCENT } from "./marketThresholds.js";

export type QuoteValidationInput = {
  fromTokenAmount?: unknown;
  toTokenAmount?: unknown;
  tokenUnitPrice?: unknown;
  usd?: unknown;
  expectedFromTokenAmount?: unknown;
  referencePrice?: unknown;
  tokenToShareRatio?: unknown;
  maxReferenceGapPercent?: number;
};

export type QuoteValidationResult =
  | { ok: true; usd: number; referenceGap: number | null }
  | { ok: false; reason: string };

function finitePositive(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveIntegerString(value: unknown): string | null {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  const text = String(value ?? "").trim();
  if (!/^(?:\d+|0x[0-9a-fA-F]+)$/.test(text)) return null;
  try {
    const amount = BigInt(text);
    return amount > BigInt(0) ? amount.toString() : null;
  } catch {
    return null;
  }
}

function referencePerShare(referencePrice: unknown, tokenToShareRatio: unknown): number | null {
  const reference = finitePositive(referencePrice);
  const ratio = finitePositive(tokenToShareRatio);
  if (reference == null || ratio == null) return null;
  const result = reference / ratio;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function validateQuote(input: QuoteValidationInput): QuoteValidationResult {
  let usd: number | null = null;

  if (input.usd !== undefined) {
    usd = finitePositive(input.usd);
    if (usd == null) return { ok: false, reason: "Quote price is not a finite positive number" };
  } else {
    const fromAmount = positiveIntegerString(input.fromTokenAmount);
    const toAmount = positiveIntegerString(input.toTokenAmount);
    const expectedFrom = input.expectedFromTokenAmount === undefined
      ? null
      : positiveIntegerString(input.expectedFromTokenAmount);
    const unitPrice = finitePositive(input.tokenUnitPrice);
    if (!fromAmount || !toAmount || unitPrice == null) {
      return { ok: false, reason: "Quote route contains invalid token amounts or unit price" };
    }
    if (input.expectedFromTokenAmount !== undefined && !expectedFrom) {
      return { ok: false, reason: "Requested input amount is invalid" };
    }
    if (expectedFrom && fromAmount !== expectedFrom) {
      return { ok: false, reason: "Quote route does not match the requested input amount" };
    }
    const outputTokens = Number(toAmount) / 1e18;
    const inputUsdt = Number(fromAmount) / 1e18;
    usd = (inputUsdt * unitPrice) / outputTokens;
    if (!Number.isFinite(usd) || usd <= 0) {
      return { ok: false, reason: "Quote route produces an invalid token price" };
    }
  }

  const ref = referencePerShare(input.referencePrice, input.tokenToShareRatio);
  const executablePerShare = input.tokenToShareRatio === undefined
    ? usd
    : (() => {
        const ratio = finitePositive(input.tokenToShareRatio);
        return ratio == null ? null : usd! / ratio;
      })();
  const referenceGap = ref != null && executablePerShare != null
    ? (executablePerShare / ref - 1) * 100
    : null;
  const maxGap = input.maxReferenceGapPercent ?? MAX_RELIABLE_GAP_PERCENT;
  if (referenceGap != null && (!Number.isFinite(referenceGap) || Math.abs(referenceGap) > maxGap)) {
    return { ok: false, reason: "Quote deviates too far from the reference price" };
  }

  return { ok: true, usd: usd!, referenceGap };
}

export function isQuoteReferenceReliable(usd: unknown, referencePrice: unknown, tokenToShareRatio: unknown): boolean {
  return validateQuote({ usd, referencePrice, tokenToShareRatio }).ok;
}
