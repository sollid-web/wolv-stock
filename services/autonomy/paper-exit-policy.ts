const INTEGER = /^(0|[1-9][0-9]*)$/;

export type PaperExitPolicy = {
  enabled: boolean;
  takeProfitBps: number | null;
  stopLossBps: number | null;
  maxHoldingMs: number | null;
};

export type PaperExitCandidate = {
  costBasisInputUnits: string;
  netProceedsInputUnits: string;
  openedAt: string;
  now: string;
};

export type PaperExitDecision =
  | { exit: false; reason: "EXIT_DISABLED" | "HOLDING_PERIOD_ACTIVE" | "NO_EXIT_TRIGGER" }
  | { exit: true; reason: "TAKE_PROFIT" | "STOP_LOSS" | "MAX_HOLDING_TIME"; returnBps: number };

/** Deterministic paper-exit decision. Amounts must be in the same input-token base units. */
export function evaluatePaperExit(policy: PaperExitPolicy, candidate: PaperExitCandidate): PaperExitDecision {
  if (!policy.enabled) return { exit: false, reason: "EXIT_DISABLED" };
  if (!INTEGER.test(candidate.costBasisInputUnits) || BigInt(candidate.costBasisInputUnits) <= BigInt(0) ||
      !INTEGER.test(candidate.netProceedsInputUnits) || BigInt(candidate.netProceedsInputUnits) < BigInt(0)) {
    throw new Error("Paper exit amounts must be non-negative base-unit integers with positive cost basis");
  }
  const opened = Date.parse(candidate.openedAt);
  const now = Date.parse(candidate.now);
  if (!Number.isFinite(opened) || !Number.isFinite(now) || now < opened) {
    throw new Error("Paper exit timestamps are invalid or move backwards");
  }
  const cost = BigInt(candidate.costBasisInputUnits);
  const proceeds = BigInt(candidate.netProceedsInputUnits);
  const returnBpsBig = ((proceeds - cost) * BigInt(10_000)) / cost;
  const returnBps = Number(returnBpsBig);
  if (!Number.isSafeInteger(returnBps)) throw new Error("Paper exit return is outside supported range");

  // Risk exits take precedence over profit-taking; max-hold is the final fallback.
  if (policy.stopLossBps !== null && (!Number.isInteger(policy.stopLossBps) || policy.stopLossBps < 0 || policy.stopLossBps > 10_000)) {
    throw new Error("stopLossBps must be an integer from 0 to 10000 or null");
  }
  if (policy.takeProfitBps !== null && (!Number.isInteger(policy.takeProfitBps) || policy.takeProfitBps < 0 || policy.takeProfitBps > 100_000)) {
    throw new Error("takeProfitBps must be an integer from 0 to 100000 or null");
  }
  if (policy.maxHoldingMs !== null && (!Number.isSafeInteger(policy.maxHoldingMs) || policy.maxHoldingMs < 1)) {
    throw new Error("maxHoldingMs must be a positive safe integer or null");
  }
  if (policy.stopLossBps !== null && returnBps <= -policy.stopLossBps) {
    return { exit: true, reason: "STOP_LOSS", returnBps };
  }
  if (policy.takeProfitBps !== null && returnBps >= policy.takeProfitBps) {
    return { exit: true, reason: "TAKE_PROFIT", returnBps };
  }
  if (policy.maxHoldingMs !== null && now - opened >= policy.maxHoldingMs) {
    return { exit: true, reason: "MAX_HOLDING_TIME", returnBps };
  }
  return { exit: false, reason: "NO_EXIT_TRIGGER" };
}
