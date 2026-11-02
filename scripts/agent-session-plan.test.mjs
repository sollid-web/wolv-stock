import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_SESSION_MAX_PRICE_IMPACT_BPS,
  AGENT_SESSION_MAX_SLIPPAGE_BPS,
  AGENT_SESSION_MAX_VALUE_WEI,
  canTransitionAgentSessionStatus,
  createAgentSessionPlan,
} from "../lib/agentSessionPlan.ts";
import { buildCapabilityTelemetry } from "../lib/agentTelemetry.ts";

test("session plan is strictly simulation-only on BSC testnet", () => {
  const plan = createAgentSessionPlan({
    ownerAddress: "0x0000000000000000000000000000000000001234",
  });

  assert.equal(plan.provider, "zerodev");
  assert.equal(plan.mode, "simulation-only");
  assert.equal(plan.status, "not-granted");
  assert.equal(plan.chainId, 97);
  assert.equal(plan.permissions.nativeValueLimitWei, AGENT_SESSION_MAX_VALUE_WEI);
  assert.equal(plan.permissions.targetAddress, null);
  assert.deepEqual(plan.permissions.assetAllowlist, []);
  assert.equal(plan.permissions.slippageBps, AGENT_SESSION_MAX_SLIPPAGE_BPS);
  assert.equal(plan.permissions.maxPriceImpactBps, AGENT_SESSION_MAX_PRICE_IMPACT_BPS);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.humanApprovalRequired, true);
  assert.equal(plan.successfulSimulationRequired, true);
  assert.deepEqual(plan.prohibited, [
    "arbitrary-contract-calls",
    "token-approvals",
    "token-transfers",
    "native-token-withdrawals",
    "withdrawals",
    "mainnet-submission",
    "signature-generation",
  ]);
});

test("configured session plan binds one router and one token while remaining ungranted", () => {
  const routerAddress = "0x0000000000000000000000000000000000000123";
  const targetTokenAddress = "0x0000000000000000000000000000000000000456";
  const plan = createAgentSessionPlan({
    ownerAddress: "0x0000000000000000000000000000000000000789",
    routerAddress,
    targetTokenAddress,
  });

  assert.equal(plan.permissions.targetAddress, routerAddress);
  assert.deepEqual(plan.permissions.assetAllowlist, [targetTokenAddress]);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.status, "not-granted");
});

test("invalid owner address is rejected", () => {
  assert.throws(
    () => createAgentSessionPlan({ ownerAddress: "not-an-address" }),
    /AGENT_SESSION_OWNER_INVALID/,
  );
});

test("partial or malformed session scope is rejected", () => {
  assert.throws(
    () => createAgentSessionPlan({
      routerAddress: "0x0000000000000000000000000000000000000123",
    }),
    /AGENT_SESSION_SCOPE_INVALID/,
  );
  assert.throws(
    () => createAgentSessionPlan({
      routerAddress: "not-an-address",
      targetTokenAddress: "0x0000000000000000000000000000000000000456",
    }),
    /AGENT_SESSION_SCOPE_INVALID/,
  );
});

test("plan never enables execution even when live submission is signaled", () => {
  const plan = createAgentSessionPlan({ liveSubmissionEnabled: true });

  assert.equal(plan.executionEnabled, false);
  assert.match(plan.reason, /remain blocked/);
});

test("telemetry binds a valid owner and preserves the emergency-stop boundary", () => {
  const ownerAddress = "0x0000000000000000000000000000000000001234";
  const telemetry = buildCapabilityTelemetry({
    ownerAddress,
    emergencyStopEnabled: true,
  });

  assert.equal(telemetry.scopedSession.ownerAddress, ownerAddress);
  assert.equal(telemetry.scopedSession.executionEnabled, false);
  assert.match(
    telemetry.scopedSession.reason,
    /Global emergency stop remains active/,
  );
});

test("status telemetry defaults to fail-safe when the global stop context is unavailable", () => {
  const telemetry = buildCapabilityTelemetry({
    ownerAddress: null,
    emergencyStopEnabled: true,
  });

  assert.equal(telemetry.executionMode, "execution-blocked");
  assert.equal(telemetry.scopedSession.executionEnabled, false);
  assert.equal(telemetry.scopedSession.status, "not-granted");
});

test("session-plan lifecycle permits only prepared-to-terminal transitions", () => {
  assert.equal(canTransitionAgentSessionStatus("PREPARED", "REVOKED"), true);
  assert.equal(canTransitionAgentSessionStatus("PREPARED", "EXPIRED"), true);
  assert.equal(canTransitionAgentSessionStatus("REVOKED", "PREPARED"), false);
  assert.equal(canTransitionAgentSessionStatus("EXPIRED", "REVOKED"), false);
});
