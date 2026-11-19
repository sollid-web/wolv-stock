import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulationInput, simulateAgentDecision, SimulationInputError } from "../lib/agentSimulation.ts";

const TOKEN = "0xd66c6B4F0be8CE5b39D52E0Fd1344c389929B378";
const NOW = 1_800_000_000_000;
const market = (priceUsd, reserveIn = 10n ** 21n, reserveOut = 5n * 10n ** 20n) => async () => ({
  priceMicros: BigInt(Math.round(priceUsd * 1_000_000)),
  reserves: { reserveIn, reserveOut },
  observedAt: NOW - 1_000,
  receivedAt: NOW - 1_000,
});
const input = { amountBnb: "0.001", entryPriceUsd: 1900, slippageBps: 100, maxPriceImpactBps: 100 };

test("price above entry: the real worker waits and nothing would be submitted", async () => {
  const result = await simulateAgentDecision(input, TOKEN, market(1950), () => NOW);
  assert.equal(result.simulated, true);
  assert.equal(result.decision, "TRIGGER_NOT_MET");
  assert.equal(result.wouldSubmit, false);
  assert.equal(result.checks.find(c => c.label.startsWith("Entry")).outcome, "wait");
});

test("price at or below entry with deep liquidity: policy checks pass and an intent is formed", async () => {
  const result = await simulateAgentDecision(input, TOKEN, market(1850), () => NOW);
  assert.equal(result.decision, "VALIDATOR_PASS");
  assert.equal(result.wouldSubmit, true);
  assert.ok(BigInt(result.minimumOutput) > 0n);
  assert.ok(result.checks.every(c => c.outcome === "pass"));
});

test("thin liquidity: rejected for price impact by the same rule as production", async () => {
  const result = await simulateAgentDecision({ ...input, amountBnb: "0.5" }, TOKEN, market(1850, 10n ** 18n, 5n * 10n ** 17n), () => NOW);
  assert.equal(result.decision, "SLIPPAGE_HIGH");
  assert.equal(result.wouldSubmit, false);
});

test("input validation rejects out-of-policy values", () => {
  for (const bad of [{ ...input, amountBnb: "0.6" }, { ...input, amountBnb: "0" }, { ...input, slippageBps: 0 }, { ...input, maxPriceImpactBps: 501 }, { ...input, entryPriceUsd: -1 }, null]) {
    assert.throws(() => parseSimulationInput(bad), SimulationInputError);
  }
  assert.deepEqual(parseSimulationInput(input), input);
});
