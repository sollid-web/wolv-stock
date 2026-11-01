import { AltanaWalletProvider, TWAKProvider } from "@bnbagent/sdk/wallets";

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
  recentTransactions: string[];
};

export function buildCapabilityTelemetry(): AgentTelemetry {
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
    recentTransactions: [],
  };
}
