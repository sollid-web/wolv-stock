import { AltanaWalletProvider, TWAKProvider } from "@bnbagent/sdk/wallets";
import { createAgentSessionPlan, type AgentSessionPlan } from "./agentSessionPlan.ts";

export type AgentTelemetry = {
  executionMode: "execution-blocked";
  agentIdentity: { standard: string; registrationId: number | null; status: string };
  commerce: { standard: string; jobId: string | null; status: string };
  sessionKey: { status: string; reason: string };
  x402: { status: string; reason: string };
  walletProviders: {
    altana: { sdkAvailable: boolean; configured: boolean };
    twak: { sdkAvailable: boolean; configured: boolean };
  };
  scopedSession: AgentSessionPlan;
  recentTransactions: string[];
};

export function buildCapabilityTelemetry(input: {
  ownerAddress?: string | null;
  emergencyStopEnabled?: boolean;
} = {}): AgentTelemetry {
  const liveSubmissionEnabled =
    process.env.ENABLE_LIVE_USEROP_SUBMISSION?.trim().toLowerCase() === "true";
  return {
    executionMode: "execution-blocked",
    agentIdentity: { standard: "ERC-8004", registrationId: null, status: "not-registered" },
    commerce: { standard: "ERC-8183", jobId: null, status: "disabled" },
    sessionKey: { status: "disabled", reason: "Agent signing is not enabled in wallet-confirmation mode." },
    x402: { status: "disabled", reason: "No autonomous commerce job is created in wallet-confirmation mode." },
    walletProviders: {
      altana: { sdkAvailable: typeof AltanaWalletProvider === "function", configured: false },
      twak: { sdkAvailable: typeof TWAKProvider === "function", configured: false },
    },
    scopedSession: liveSubmissionEnabled
      ? createAgentSessionPlan({
          ownerAddress: input.ownerAddress,
          liveSubmissionEnabled: true,
          emergencyStopEnabled: input.emergencyStopEnabled,
        })
      : createAgentSessionPlan({
          ownerAddress: input.ownerAddress,
          emergencyStopEnabled: input.emergencyStopEnabled,
        }),
    recentTransactions: [],
  };
}
