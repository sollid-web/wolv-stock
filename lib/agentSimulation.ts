import { parseEther, type Address } from "viem";
import { hashAgentPolicy } from "./agentPolicyHash.ts";
import { DECISION_LABELS } from "./agentPublicStatus.ts";
import {
  AgentWorker,
  MAX_TRADE_BNB,
  type AgentCycleTelemetry,
  type AgentExecutionIntent,
  type AgentStrategy,
  type MarketSnapshot,
  type ValidatorSnapshot,
} from "../services/agentWorker.ts";

/** Clearly synthetic identities: the simulation never touches a real account or signer. */
const SIMULATED_OWNER = "0x0000000000000000000000000000000000005111" as Address;
const SIMULATED_ACCOUNT = "0x0000000000000000000000000000000000005112" as Address;
const SIMULATED_SIGNER = "0x0000000000000000000000000000000000005113" as Address;
const SIMULATED_STRATEGY_ID = "simulation";

export type SimulationInput = {
  amountBnb: string;
  entryPriceUsd: number;
  slippageBps: number;
  maxPriceImpactBps: number;
};

export type SimulationCheck = { label: string; outcome: "pass" | "fail" | "wait" | "skipped"; detail: string };

export type SimulationResult = {
  simulated: true;
  decision: string;
  decisionLabel: string;
  wouldSubmit: boolean;
  observedPriceUsd: number;
  entryPriceUsd: number;
  priceImpactBps: number | null;
  minimumOutput: string | null;
  checks: SimulationCheck[];
  marketObservedAt: number;
};

export class SimulationInputError extends Error {}

export function parseSimulationInput(value: unknown): SimulationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SimulationInputError("Body must be an object.");
  const body = value as Record<string, unknown>;
  const amountBnb = typeof body.amountBnb === "string" ? body.amountBnb.trim() : "";
  if (!/^\d+(\.\d{1,18})?$/.test(amountBnb)) throw new SimulationInputError("amountBnb must be a decimal string.");
  const amountWei = parseEther(amountBnb);
  if (amountWei <= BigInt(0) || amountWei > MAX_TRADE_BNB) throw new SimulationInputError("amountBnb must be greater than 0 and at most 0.5.");
  const entryPriceUsd = Number(body.entryPriceUsd);
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0 || entryPriceUsd > 10_000_000) throw new SimulationInputError("entryPriceUsd is out of range.");
  const slippageBps = Number(body.slippageBps);
  const maxPriceImpactBps = Number(body.maxPriceImpactBps);
  for (const [name, bps] of [["slippageBps", slippageBps], ["maxPriceImpactBps", maxPriceImpactBps]] as const) {
    if (!Number.isInteger(bps) || bps < 1 || bps > 500) throw new SimulationInputError(`${name} must be an integer from 1 to 500.`);
  }
  return { amountBnb, entryPriceUsd, slippageBps, maxPriceImpactBps };
}

/**
 * Runs the production AgentWorker decision path once against a live market snapshot and a
 * hypothetical, owner-authorized policy built from the inputs. No executor is attached, so the
 * simulation can only observe the decision; it can never sign, submit, or trade.
 */
export async function simulateAgentDecision(
  input: SimulationInput,
  targetToken: Address,
  readMarket: (strategy: AgentStrategy) => Promise<MarketSnapshot>,
  now: () => number = Date.now,
): Promise<SimulationResult> {
  const amountWei = parseEther(input.amountBnb);
  const entryPriceMicros = BigInt(Math.round(input.entryPriceUsd * 1_000_000));
  const strategy: AgentStrategy = {
    id: SIMULATED_STRATEGY_ID,
    ownerAddress: SIMULATED_OWNER,
    account: SIMULATED_ACCOUNT,
    targetToken,
    amountBnb: amountWei,
    entryPriceMicros,
    slippageBps: input.slippageBps,
    maxPriceImpactBps: input.maxPriceImpactBps,
  };
  const expiresAt = BigInt(Math.floor(now() / 1000) + 30 * 24 * 60 * 60);
  const validator: ValidatorSnapshot = {
    paused: false,
    installed: true,
    revoked: false,
    targetToken,
    rollingVolume: BigInt(0),
    policyConfigured: true,
    policyHash: hashAgentPolicy({
      strategyId: SIMULATED_STRATEGY_ID,
      ownerAddress: SIMULATED_OWNER,
      account: SIMULATED_ACCOUNT,
      targetToken,
      maxTradeValue: amountWei,
      expiresAt,
      intentSigner: SIMULATED_SIGNER,
      amountBnb: amountWei,
      entryPriceMicros,
      slippageBps: input.slippageBps,
      maxPriceImpactBps: input.maxPriceImpactBps,
    }),
    maxTradeValue: amountWei,
    policyExpiresAt: expiresAt,
    intentSigner: SIMULATED_SIGNER,
    entryPriceMicros,
    maxSlippageBps: input.slippageBps,
    maxPriceImpactBps: input.maxPriceImpactBps,
  };

  let market: MarketSnapshot | null = null;
  const events: AgentCycleTelemetry[] = [];
  let intent: AgentExecutionIntent | null = null;
  const worker = new AgentWorker({
    strategies: [strategy],
    readMarket: async (current) => { market = await readMarket(current); return market; },
    readValidator: async () => validator,
    log: (event) => { events.push(event); },
    alert: () => undefined,
    onIntent: (captured) => { intent = captured; },
    now,
  });
  await worker.evaluateOnce();

  const event = events.at(-1);
  if (!event || !market) throw new Error(event?.detail ?? "The market could not be read for this simulation.");
  const snapshot = market as MarketSnapshot;
  const decision = event.reasonCode;
  const observedPriceUsd = Number(snapshot.priceMicros) / 1_000_000;
  const captured = intent as AgentExecutionIntent | null;
  const triggerMet = snapshot.priceMicros <= entryPriceMicros;
  const impactFailed = decision === "SLIPPAGE_HIGH";

  const checks: SimulationCheck[] = [
    { label: "Policy hook installed and active", outcome: "pass", detail: "Simulated owner policy: installed, not paused, not revoked." },
    { label: "Trade within per-trade and rolling caps", outcome: "pass", detail: `${input.amountBnb} BNB ≤ cap ${input.amountBnb} BNB; rolling volume 0 of 1 BNB.` },
    { label: "Signed policy matches strategy", outcome: "pass", detail: "Policy hash recomputed from the strategy and compared." },
    {
      label: "Entry condition (Chainlink price)",
      outcome: triggerMet ? "pass" : "wait",
      detail: `Live ${observedPriceUsd.toFixed(2)} USD ${triggerMet ? "≤" : ">"} entry ${input.entryPriceUsd.toFixed(2)} USD.`,
    },
    {
      label: "Price impact within limit",
      outcome: !triggerMet ? "skipped" : impactFailed ? "fail" : "pass",
      detail: !triggerMet
        ? "Not evaluated: the agent waits before quoting."
        : impactFailed
          ? event.detail ?? "Pool price impact exceeds the policy limit."
          : `Impact ${event.priceImpactBps ?? captured?.priceImpactBps ?? 0} bps ≤ ${input.maxPriceImpactBps} bps.`,
    },
  ];

  return {
    simulated: true,
    decision,
    decisionLabel: DECISION_LABELS[decision] ?? decision,
    wouldSubmit: decision === "VALIDATOR_PASS" && captured !== null,
    observedPriceUsd,
    entryPriceUsd: input.entryPriceUsd,
    priceImpactBps: event.priceImpactBps ?? captured?.priceImpactBps ?? null,
    minimumOutput: captured ? captured.amountOutMin.toString() : null,
    checks,
    marketObservedAt: snapshot.observedAt,
  };
}
