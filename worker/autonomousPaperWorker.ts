import { randomUUID } from "node:crypto";
import { readMarketOpportunities } from "../services/marketPriceCache.ts";
import {
  createExecutionIntent, evaluateRiskPolicy, transitionExecutionIntent,
  type ExecutionIntent, type RiskPolicy,
} from "../services/autonomy/execution-domain.ts";
import {
  acquireExecutionLease, compareAndSwapExecutionIntent,
  createExecutionIntentIfAbsent, releaseExecutionLease,
} from "../services/autonomy/supabase-execution-repository.ts";

const INTERVAL_MS = Math.max(10_000, Number(process.env.WOLV_AUTONOMY_POLL_MS ?? 15_000));
const OWNER_ID = required("WOLV_AUTONOMY_OWNER_ID");
const WALLET = required("WOLV_AUTONOMY_WALLET_ADDRESS");
const INPUT_TOKEN = required("WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS");
const AMOUNT_IN = required("WOLV_AUTONOMY_ORDER_AMOUNT_BASE_UNITS");
const STRATEGY_ID = process.env.WOLV_AUTONOMY_STRATEGY_ID ?? "rwa-dislocation-v1";
const STRATEGY_VERSION = process.env.WOLV_AUTONOMY_STRATEGY_VERSION ?? "1";
const POLICY_VERSION = process.env.WOLV_AUTONOMY_POLICY_VERSION ?? "paper-policy-1";
const LEASE_MS = 30_000;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function parsePolicy(): RiskPolicy {
  const raw = required("WOLV_AUTONOMY_RISK_POLICY_JSON");
  const policy = JSON.parse(raw) as RiskPolicy;
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.allowedChainIds) ||
      !Array.isArray(policy.allowedTokenAddresses) || !Array.isArray(policy.allowedInputTokenAddresses)) {
    throw new Error("WOLV_AUTONOMY_RISK_POLICY_JSON is malformed.");
  }
  return policy;
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(OWNER_ID)) {
  throw new Error("WOLV_AUTONOMY_OWNER_ID must be a UUID.");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(WALLET) || !/^0x[a-fA-F0-9]{40}$/.test(INPUT_TOKEN)) {
  throw new Error("WOLV_AUTONOMY_WALLET_ADDRESS and WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS must be EVM addresses.");
}
const POLICY = parsePolicy();

function next(intent: ExecutionIntent, state: Parameters<typeof transitionExecutionIntent>[1], type: string, detail?: Record<string, unknown>) {
  return transitionExecutionIntent(intent, state, {
    type, at: new Date().toISOString(), actor: "worker", ...(detail ? { detail } : {}),
  });
}

async function persistTransition(intent: ExecutionIntent, expectedVersion: number) {
  const saved = await compareAndSwapExecutionIntent(intent, expectedVersion);
  if (!saved) throw new Error(`Execution intent ${intent.id} changed concurrently; refusing stale write.`);
}

async function qualifyOpportunity(opportunity: Awaited<ReturnType<typeof readMarketOpportunities>>[number]) {
  if (opportunity.stale || opportunity.status !== "ACTIVE" || opportunity.direction !== "DISCOUNT") return;
  const utcDay = new Date().toISOString().slice(0, 10);
  // One strategy allocation per owner per UTC day: conservative until the persistent
  // exposure ledger and atomic portfolio-wide budget reservation are enabled.
  const idempotencyKey = [STRATEGY_ID, STRATEGY_VERSION, utcDay].join(":");
  const candidate = createExecutionIntent({
    id: randomUUID(), idempotencyKey, ownerId: OWNER_ID, walletAddress: WALLET,
    chainId: String(opportunity.chainId), tokenAddress: opportunity.tokenAddress,
    inputTokenAddress: INPUT_TOKEN, amountIn: AMOUNT_IN,
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    policyVersion: POLICY_VERSION, now: new Date().toISOString(),
  });
  const created = await createExecutionIntentIfAbsent(candidate);
  let intent = created.intent;
  // A daily strategy key may already belong to a different top-ranked asset.
  // Never apply the current loop item to an intent created for another token.
  if (intent.tokenAddress.toLowerCase() !== opportunity.tokenAddress.toLowerCase()) return;
  if (intent.state !== "DISCOVERED") return;
  const lease = await acquireExecutionLease(OWNER_ID, intent.id, LEASE_MS);
  if (!lease) return;
  try {
    const originalVersion = intent.version;
    intent = next(intent, "QUALIFIED", "OPPORTUNITY_QUALIFIED", {
      ticker: opportunity.ticker, direction: opportunity.direction,
      deviationBps: opportunity.deviationBps, providerTimestamp: opportunity.providerTimestamp,
      executionMode: "PAPER_ONLY",
    });
    await persistTransition(intent, originalVersion);

    const decision = evaluateRiskPolicy(POLICY, {
      chainId: String(opportunity.chainId), tokenAddress: opportunity.tokenAddress,
      inputTokenAddress: INPUT_TOKEN, amountIn: AMOUNT_IN,
      currentPosition: "0", dailySpend: "0",
      quoteObservedAt: opportunity.providerTimestamp, now: new Date().toISOString(),
      slippageBps: 0, priceImpactBps: 0, gasCost: "0",
      expectedEdgeBps: Math.abs(opportunity.deviationBps),
    });
    const version = intent.version;
    intent = decision.allowed
      ? next(intent, "RISK_APPROVED", "PAPER_RISK_APPROVED", { code: decision.code, mode: "PAPER_ONLY" })
      : next(intent, "REJECTED_POLICY", "PAPER_POLICY_REJECTED", { code: decision.code, reason: decision.reason });
    await persistTransition(intent, version);
    console.info(`[autonomy-worker] ${decision.allowed ? "risk-approved" : "rejected"} ${intent.id} ${opportunity.ticker} mode=PAPER_ONLY`);
  } finally {
    await releaseExecutionLease(OWNER_ID, intent.id, lease);
  }
}

async function cycle() {
  const opportunities = await readMarketOpportunities({ status: "ACTIVE", limit: 100 });
  opportunities.sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps));
  for (const opportunity of opportunities) {
    try { await qualifyOpportunity(opportunity); }
    catch (error) {
      console.error("[autonomy-worker] opportunity processing failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
}
async function main() {
  console.info(`[autonomy-worker] started; interval=${INTERVAL_MS}ms; mode=PAPER_ONLY`);
  for (;;) {
    const started = Date.now();
    try { await cycle(); }
    catch (error) { console.error("[autonomy-worker] cycle failed:", error instanceof Error ? error.message : "unknown error"); }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, INTERVAL_MS - (Date.now() - started))));
  }
}
main().catch((error) => {
  console.error("[autonomy-worker] fatal startup error:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
