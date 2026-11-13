#!/usr/bin/env node
"use strict";

const OWNER_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TARGET_CONTRACT = "0xa9ee28c80f960b889dfbd1902055218cba016f75";
const SCHEDULE_NAME = "diagnostic-option-b-nvda";

async function main() {
  const { loadEnvConfig } = (await import("@next/env")).default;
  loadEnvConfig(process.cwd());

  if (!process.argv.includes("--apply")) {
    console.log("Dry run only. Re-run with --apply and WOLV_ALLOW_DIAGNOSTIC_STRATEGY_INSERT=true to write the test schedule.");
    console.log(JSON.stringify(await createScheduleInput(Date.now()), null, 2));
    return;
  }
  if (process.env.WOLV_ALLOW_DIAGNOSTIC_STRATEGY_INSERT !== "true") {
    throw new Error("Refusing to write: set WOLV_ALLOW_DIAGNOSTIC_STRATEGY_INSERT=true explicitly for this diagnostic.");
  }

  const { AgentMemoryStore } = await import("../services/agentMemoryStore.ts");
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const existing = (await store.listSchedules(OWNER_ADDRESS, 100))
      .find((schedule) => schedule.name === SCHEDULE_NAME);
    if (existing && (existing.enabled || existing.executionMode !== "MANUAL" ||
      existing.strategyType !== "DCA")) {
      throw new Error("The diagnostic schedule name already belongs to a non-disabled or non-manual schedule; refusing to overwrite it.");
    }

    const now = Date.now();
    const input = await createScheduleInput(now);
    const { scheduleId } = await store.saveSchedule(input);
    console.log(JSON.stringify({
      scheduleId,
      ownerAddress: OWNER_ADDRESS,
      strategyType: "DCA",
      executionMode: "MANUAL",
      enabled: false,
      targetContract: TARGET_CONTRACT,
      insertedOrUpdated: true,
    }, null, 2));
  } finally {
    await store.close();
  }
}

async function createScheduleInput(now) {
  const { createHash, randomUUID } = await import("node:crypto");
  const strategyConfig = {
    ticker: "NVDA",
    tokenAddress: TARGET_CONTRACT,
    amount: "50.00",
    maxPerRun: "50.00",
    maxRollingExposure: "500.00",
    rollingWindowSeconds: 86_400,
    maxPriceDeviationPercent: 0.5,
    autonomousEnabled: false,
  };
  const policyHash = createHash("sha256")
    .update(JSON.stringify({
      strategyType: "DCA",
      executionMode: "MANUAL",
      enabled: false,
      strategyConfig,
      diagnostic: "option-b-v8",
    }))
    .digest("hex");

  return {
    ownerAddress: OWNER_ADDRESS,
    scheduleId: randomUUID(),
    name: SCHEDULE_NAME,
    enabled: false,
    intervalSeconds: 86_400,
    policyVersion: "diagnostic-option-b-v8",
    policyHash,
    nextRunAt: now + 86_400_000,
    strategyType: "DCA",
    executionMode: "MANUAL",
    strategyConfig,
    createdAt: now,
    updatedAt: now,
  };
}

main().catch((error) => {
  console.error(`Diagnostic strategy injection failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
