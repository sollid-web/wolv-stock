import { isAddress } from "viem";

export const AGENT_SESSION_TESTNET_CHAIN_ID = 97;
export const AGENT_SESSION_VALIDITY_SECONDS = 7 * 24 * 60 * 60;
export const AGENT_SESSION_MAX_VALUE_WEI = "500000000000000000";
export const AGENT_SESSION_MAX_SLIPPAGE_BPS = 100;
export const AGENT_SESSION_MAX_PRICE_IMPACT_BPS = 300;

export type AgentSessionPlan = {
  provider: "zerodev";
  mode: "simulation-only";
  status: "not-granted";
  chainId: 97;
  ownerAddress: string | null;
  permissions: {
    targetType: "router";
    selector: "swapExactETHForTokens";
    targetAddress: string | null;
    assetAllowlist: string[];
    nativeValueLimitWei: typeof AGENT_SESSION_MAX_VALUE_WEI;
    validitySeconds: typeof AGENT_SESSION_VALIDITY_SECONDS;
    slippageBps: typeof AGENT_SESSION_MAX_SLIPPAGE_BPS;
    maxPriceImpactBps: typeof AGENT_SESSION_MAX_PRICE_IMPACT_BPS;
  };
  prohibited: string[];
  executionEnabled: false;
  humanApprovalRequired: true;
  successfulSimulationRequired: true;
  reason: string;
};

export type AgentSessionPlanInput = {
  ownerAddress?: string | null;
  routerAddress?: string | null;
  targetTokenAddress?: string | null;
  liveSubmissionEnabled?: boolean;
  emergencyStopEnabled?: boolean;
};

export type AgentSessionLifecycleStatus =
  | "PREPARED"
  | "REVOKED"
  | "EXPIRED";

export function canTransitionAgentSessionStatus(
  current: AgentSessionLifecycleStatus,
  next: AgentSessionLifecycleStatus,
): boolean {
  if (current === "REVOKED" || current === "EXPIRED") return false;
  return current === "PREPARED" && next !== "PREPARED";
}

export function createAgentSessionPlan(
  input: AgentSessionPlanInput = {},
): AgentSessionPlan {
  const ownerAddress = input.ownerAddress?.trim() || null;
  if (ownerAddress && !isAddress(ownerAddress)) {
    throw new Error("AGENT_SESSION_OWNER_INVALID");
  }
  const routerAddress = input.routerAddress?.trim() || null;
  const targetTokenAddress = input.targetTokenAddress?.trim() || null;
  if (
    (routerAddress && !isAddress(routerAddress)) ||
    (targetTokenAddress && !isAddress(targetTokenAddress)) ||
    Boolean(routerAddress) !== Boolean(targetTokenAddress)
  ) {
    throw new Error("AGENT_SESSION_SCOPE_INVALID");
  }
  const reason = input.emergencyStopEnabled
    ? "Global emergency stop remains active; no scoped session grant is permitted."
    : input.liveSubmissionEnabled
      ? "Live submission is enabled, but scoped session grants are not implemented; signing and UserOperation submission remain blocked."
      : routerAddress && targetTokenAddress
        ? "A restricted router and token scope is recorded for review; no session grant, signing, or UserOperation submission is enabled."
        : "No approved router and token scope is configured; wallet signing and UserOperation submission remain blocked.";

  return {
    provider: "zerodev",
    mode: "simulation-only",
    status: "not-granted",
    chainId: AGENT_SESSION_TESTNET_CHAIN_ID,
    ownerAddress,
    permissions: {
      targetType: "router",
      selector: "swapExactETHForTokens",
      targetAddress: routerAddress,
      assetAllowlist: targetTokenAddress ? [targetTokenAddress.toLowerCase()] : [],
      nativeValueLimitWei: AGENT_SESSION_MAX_VALUE_WEI,
      validitySeconds: AGENT_SESSION_VALIDITY_SECONDS,
      slippageBps: AGENT_SESSION_MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: AGENT_SESSION_MAX_PRICE_IMPACT_BPS,
    },
    prohibited: [
      "arbitrary-contract-calls",
      "token-approvals",
      "token-transfers",
      "native-token-withdrawals",
      "withdrawals",
      "mainnet-submission",
      "signature-generation",
    ],
    executionEnabled: false,
    humanApprovalRequired: true,
    successfulSimulationRequired: true,
    reason,
  };
}
