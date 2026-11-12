import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePaperExit } from "../services/autonomy/paper-exit-policy.ts";

const base = {
  enabled: true, takeProfitBps: 500, stopLossBps: 300, maxHoldingMs: 86_400_000,
};
const candidate = {
  costBasisInputUnits: "1000000", netProceedsInputUnits: "1000000",
  openedAt: "2026-11-10T00:00:00.000Z", now: "2026-11-10T12:00:00.000Z",
};

test("disabled exit policy never closes a position", () => {
  assert.deepEqual(evaluatePaperExit({ ...base, enabled: false }, candidate), { exit: false, reason: "EXIT_DISABLED" });
});
test("take-profit uses exact integer basis-point arithmetic", () => {
  assert.deepEqual(evaluatePaperExit(base, { ...candidate, netProceedsInputUnits: "1050000" }),
    { exit: true, reason: "TAKE_PROFIT", returnBps: 500 });
});
test("stop-loss takes precedence over time and profit rules", () => {
  assert.deepEqual(evaluatePaperExit(base, { ...candidate, netProceedsInputUnits: "9700000".slice(0, 6), now: "2026-11-11T00:00:00.000Z" }),
    { exit: true, reason: "STOP_LOSS", returnBps: -300 });
});
test("max holding time exits when no price threshold fired", () => {
  assert.deepEqual(evaluatePaperExit(base, { ...candidate, now: "2026-11-11T00:00:00.000Z" }),
    { exit: true, reason: "MAX_HOLDING_TIME", returnBps: 0 });
});
test("holds when no configured threshold is reached", () => {
  assert.deepEqual(evaluatePaperExit(base, candidate), { exit: false, reason: "NO_EXIT_TRIGGER" });
});
test("rejects invalid amounts and timestamps", () => {
  assert.throws(() => evaluatePaperExit(base, { ...candidate, costBasisInputUnits: "1.5" }));
  assert.throws(() => evaluatePaperExit(base, { ...candidate, now: "invalid" }));
});
