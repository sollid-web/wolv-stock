import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentMemoryStorePort } from "./agentMemoryStore.ts";
import type { DcaCandidate } from "./recurringIntentService.ts";

const MAX_WORKER_HEARTBEAT_AGE_MS = 15_000;

export type ScopedDcaDelegatedPolicy = {
  ownerAddress: string;
  scheduleId: string;
  chainId: number;
  tokenAddress: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  maxPerRun: string;
  maxRollingExposure: string;
  expiresAt: number;
};

export type DcaExecutorResult = {
  status:
    | "MANUAL_PROPOSAL"
    | "AUTONOMOUS_BLOCKED"
    | "AUTONOMOUS_READY_EXECUTION_BLOCKED"
    | "DUPLICATE";
  claimId: string | null;
  alertId: string | null;
  transactionSubmitted: false;
  proposal: null | {
    runKey: string;
    ticker: string;
    tokenAddress: string;
    amount: string;
    expectedOutputs: DcaCandidate["expectedOutputs"];
    issuedAt: number;
    expiresAt: number;
    nextStep: string;
  };
  blockers: string[];
};

export async function processDcaCandidate(input: {
  store: Pick<AgentMemoryStorePort, "claimExecution" | "updateExecutionClaim" | "recordAlert">;
  ownerAddress: string;
  candidate: DcaCandidate;
  now?: number;
  delegatedPolicy?: ScopedDcaDelegatedPolicy | null;
  persistentWorkerHeartbeat?: { active: boolean; observedAt: number } | null;
}): Promise<DcaExecutorResult> {
  const now = input.now ?? Date.now();
  const ownerAddress = input.ownerAddress.toLowerCase();
  const candidate = input.candidate;
  if (!isEvmAddress(ownerAddress) || candidate.ownerAddress !== ownerAddress ||
    candidate.expiresAt <= now || !/^[a-f0-9]{64}$/.test(candidate.runKey) ||
    !/^[a-f0-9]{64}$/.test(candidate.policyHash)) {
    throw new TypeError("DCA candidate is stale or does not match its owner-scoped schedule.");
  }

  const claimId = randomUUID();
  const claim = await input.store.claimExecution({
    claimId,
    scheduleId: candidate.scheduleId,
    ownerAddress,
    runKey: candidate.runKey,
    policyHash: candidate.policyHash,
    createdAt: now,
    notionalValue: candidate.config.amount,
    rollingSince: now - candidate.config.rollingWindowSeconds * 1_000,
    maxRollingExposure: candidate.config.maxRollingExposure,
  });
  if (!claim.claimId) {
    return {
      status: "DUPLICATE",
      claimId: null,
      alertId: null,
      transactionSubmitted: false,
      proposal: null,
      blockers: ["This DCA interval already has an execution-ledger claim."],
    };
  }

  if (candidate.mode === "MANUAL") {
    const message = `DCA proposal ready for ${candidate.config.ticker}: ${candidate.config.amount} USDT. A fresh quote must be rebuilt from the authenticated UI before wallet signing.`;
    const alertId = await input.store.recordAlert({
      ownerAddress,
      claimId,
      severity: "INFO",
      kind: "DCA_MANUAL_PROPOSAL",
      message,
      createdAt: now,
    });
    await input.store.updateExecutionClaim(claimId, ownerAddress, {
      status: "STOPPED",
      at: now,
      failureCode: "MANUAL_APPROVAL_REQUIRED",
      failureDetail: "No transaction payload was persisted; the UI must request a fresh quote after the user initiates signing.",
    });
    return {
      status: "MANUAL_PROPOSAL",
      claimId,
      alertId,
      transactionSubmitted: false,
      proposal: {
        runKey: candidate.runKey,
        ticker: candidate.config.ticker,
        tokenAddress: candidate.config.tokenAddress,
        amount: candidate.config.amount,
        expectedOutputs: candidate.expectedOutputs,
        issuedAt: candidate.issuedAt,
        expiresAt: candidate.expiresAt,
        nextStep: "Open the manual confirmation UI to obtain a new authenticated Flash quote and sign it in the browser wallet.",
      },
      blockers: [],
    };
  }

  const blockers = autonomousBlockers(input, now);
  if (blockers.length > 0) {
    const alertId = await input.store.recordAlert({
      ownerAddress,
      claimId,
      severity: "WARNING",
      kind: "DCA_AUTONOMOUS_BLOCKED",
      message: blockers.join(" "),
      createdAt: now,
    });
    await input.store.updateExecutionClaim(claimId, ownerAddress, {
      status: "STOPPED",
      at: now,
      failureCode: "AUTONOMOUS_GATES_BLOCKED",
      failureDetail: blockers.join(" ").slice(0, 1_000),
    });
    return {
      status: "AUTONOMOUS_BLOCKED",
      claimId,
      alertId,
      transactionSubmitted: false,
      proposal: null,
      blockers,
    };
  }

  const alertId = await input.store.recordAlert({
    ownerAddress,
    claimId,
    severity: "WARNING",
    kind: "DCA_AUTONOMOUS_EXECUTION_BLOCKED",
    message: "All policy gates passed, but this DCA adapter does not sign or broadcast transactions.",
    createdAt: now,
  });
  await input.store.updateExecutionClaim(claimId, ownerAddress, {
    status: "STOPPED",
    at: now,
    failureCode: "SIGNING_ADAPTER_UNAVAILABLE",
    failureDetail: "Execution is intentionally blocked; no signing or broadcast adapter is configured.",
  });
  return {
    status: "AUTONOMOUS_READY_EXECUTION_BLOCKED",
    claimId,
    alertId,
    transactionSubmitted: false,
    proposal: null,
    blockers: ["Autonomous signing and broadcasting are not implemented by this adapter."],
  };
}

function autonomousBlockers(
  input: {
    candidate: DcaCandidate;
    delegatedPolicy?: ScopedDcaDelegatedPolicy | null;
    persistentWorkerHeartbeat?: { active: boolean; observedAt: number } | null;
  },
  now: number,
): string[] {
  const blockers: string[] = [];
  if (process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED !== "true" ||
    process.env.WOLV_AUTONOMOUS_TRADING_ENABLED !== "true" ||
    process.env.ENABLE_LIVE_USEROP_SUBMISSION !== "true") {
    blockers.push("Global autonomous execution gates are not both enabled.");
  }
  if (!input.candidate.config.autonomousEnabled) {
    blockers.push("The DCA strategy autonomous gate is disabled.");
  }
  const policy = input.delegatedPolicy;
  if (!policy ||
    policy.status !== "ACTIVE" ||
    policy.ownerAddress.toLowerCase() !== input.candidate.ownerAddress ||
    policy.scheduleId !== input.candidate.scheduleId ||
    policy.chainId !== 56 ||
    policy.tokenAddress.toLowerCase() !== input.candidate.config.tokenAddress.toLowerCase() ||
    !Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= now ||
    !amountWithin(policy.maxPerRun, input.candidate.config.amount) ||
    !amountWithin(policy.maxRollingExposure, input.candidate.config.maxRollingExposure)) {
    blockers.push("An active, unexpired delegated policy scoped to this owner, schedule, chain, asset, and limits is required.");
  }
  const heartbeat = input.persistentWorkerHeartbeat;
  if (!heartbeat || heartbeat.active !== true ||
    !Number.isSafeInteger(heartbeat.observedAt) ||
    now - heartbeat.observedAt < 0 ||
    now - heartbeat.observedAt > MAX_WORKER_HEARTBEAT_AGE_MS) {
    blockers.push("A persistent server worker with a fresh heartbeat is required.");
  }
  return blockers;
}

function amountWithin(limit: string, amount: string): boolean {
  return /^\d+(?:\.\d{1,18})?$/.test(limit) &&
    /^\d+(?:\.\d{1,18})?$/.test(amount) &&
    decimalToUnits(amount) <= decimalToUnits(limit);
}

function decimalToUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * (BigInt(10) ** BigInt(18)) + BigInt(fraction.padEnd(18, "0"));
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}
