import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightGate } from "../lib/singleFlightGate.ts";

test("blocks an overlapping wallet request until the active request settles", async () => {
  const runOnce = createSingleFlightGate();
  let resolveFirst;
  let duplicateCalls = 0;
  const first = runOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));

  await assert.rejects(
    runOnce(async () => {
      duplicateCalls += 1;
      return "duplicate";
    }),
    /already in progress/
  );
  assert.equal(duplicateCalls, 0);

  resolveFirst("tx-hash");
  assert.equal(await first, "tx-hash");
  assert.equal(await runOnce(async () => "next-request"), "next-request");
});

test("releases the gate when a wallet request rejects", async () => {
  const runOnce = createSingleFlightGate();
  await assert.rejects(runOnce(async () => { throw new Error("wallet rejected"); }), /wallet rejected/);
  assert.equal(await runOnce(async () => "retry-after-settlement"), "retry-after-settlement");
});
