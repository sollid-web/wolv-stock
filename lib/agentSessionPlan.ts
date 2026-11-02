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
    nativeValueLimitWei: typeof AGENT_SESSION_MAX_VALUE_WEI;
    validitySeconds: typeof AGENT_SESSION_VALIDITY_SECONDS;
    slippageBps: typeof AGENT_SESSION_MAX_SLIPPAGE_BPS;
    maxPriceImpactBps: typeof AGENT_SESSION_MAX_PRICE_IMPACT_BPS;
  };
  prohibited: string[];
  executionEnabled: false;
  reason: string;
};

export type AgentSessionPlanInput = {
  ownerAddress?: string | null;
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
  const reason = input.emergencyStopEnabled
    ? "Global emergency stop remains active; no scoped session grant is permitted."
    : input.liveSubmissionEnabled
      ? "Live submission is enabled, but scoped session grants are not implemented; signing and UserOperation submission remain blocked."
      : "Scoped session grants are not enabled; wallet signing and UserOperation submission remain blocked.";

  return {
    provider: "zerodev",
    mode: "simulation-only",
    status: "not-granted",
    chainId: AGENT_SESSION_TESTNET_CHAIN_ID,
    ownerAddress,
    permissions: {
      targetType: "router",
      selector: "swapExactETHForTokens",
      nativeValueLimitWei: AGENT_SESSION_MAX_VALUE_WEI,
      validitySeconds: AGENT_SESSION_VALIDITY_SECONDS,
      slippageBps: AGENT_SESSION_MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: AGENT_SESSION_MAX_PRICE_IMPACT_BPS,
    },
    prohibited: [
      "arbitrary-contract-calls",
      "token-transfers",
      "native-token-withdrawals",
      "mainnet-submission",
      "signature-generation",
    ],
    executionEnabled: false,
    reason,
  };
}
