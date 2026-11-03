import "server-only";
import { evaluateRiskPolicy, type RiskPolicy } from "../lib/agentControlPlane.ts";

export type AutonomousTradeIntent = {
  ownerAddress: string;
  assetAddress: string;
  direction: "BUY" | "SELL";
  notional: string;
  dailyExposure: string;
  recentProposalCount: number;
  slippageBps: number;
  referenceDeviationPercent: number | null;
  dataFresh: boolean;
  quoteExpiresAt: number | null;
  availableBalance: string | null;
  session: string;
  chainId: 97 | 56;
};

export type AutonomousTradingDecision =
  | { allowed: true; policyVersion: string }
  | { allowed: false; reasons: string[] };

export function evaluateAutonomousTradingGate(
  policy: RiskPolicy | null,
  intent: AutonomousTradeIntent,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): AutonomousTradingDecision {
  if (env.WOLV_AUTONOMOUS_TRADING_ENABLED !== "true") {
    return { allowed: false, reasons: ["Autonomous trading is disabled."] };
  }
  if (!policy) {
    return { allowed: false, reasons: ["No active deterministic risk policy is configured."] };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(intent.ownerAddress)) {
    return { allowed: false, reasons: ["Owner wallet address is invalid."] };
  }
  if (env.ENABLE_LIVE_USEROP_SUBMISSION !== "true") {
    return { allowed: false, reasons: ["Live UserOperation submission is disabled."] };
  }
  if (intent.chainId === 56 &&
    (env.ENABLE_MAINNET_AGENT_TRADING !== "true" ||
      env.MAINNET_AGENT_TRADING_ACK !== "I_ACCEPT_AUTONOMOUS_MAINNET_RISK")) {
    return { allowed: false, reasons: ["Mainnet autonomous trading is not separately authorized."] };
  }
  if (intent.chainId !== 97 && intent.chainId !== 56) {
    return { allowed: false, reasons: ["Unsupported autonomous-trading chain."] };
  }

  const decision = evaluateRiskPolicy({
    policy,
    assetKey: intent.assetAddress.toLowerCase(),
    direction: intent.direction,
    notional: intent.notional,
    dailyExposure: intent.dailyExposure,
    recentProposalCount: intent.recentProposalCount,
    slippageBps: intent.slippageBps,
    referenceDeviationPercent: intent.referenceDeviationPercent,
    dataFresh: intent.dataFresh,
    quoteExpiresAt: intent.quoteExpiresAt,
    availableBalance: intent.availableBalance,
    session: intent.session,
    now,
  });
  if (!decision.accepted) {
    return { allowed: false, reasons: decision.refusalReasons };
  }
  return { allowed: true, policyVersion: decision.policyVersion };
}
