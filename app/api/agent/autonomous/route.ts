import { NextResponse } from "next/server";
import { resolveAgentExecutionNetwork } from "@/services/agentExecutor";
import { authorizeBawWalletRequest } from "@/services/bawWalletAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeBawWalletRequest(
    request,
    process.env.BAW_WALLET_API_TOKEN,
  );
  if (authorization !== "authorized") {
    return Response.json(
      { error: "A valid operator authorization is required." },
      { status: authorization === "not_configured" ? 503 : 401, headers },
    );
  }

  const configuredChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "");
  const network = resolveAgentExecutionNetwork(
    configuredChainId,
    process.env,
  );
  const enabled = process.env.WOLV_AUTONOMOUS_TRADING_ENABLED === "true";
  const blockers: string[] = [];
  if (!enabled) blockers.push("Autonomous trading is disabled.");
  if (!network.allowed) blockers.push(network.reason);

  return NextResponse.json({
    mode: enabled ? "POLICY_AUTHORIZED_AUTONOMOUS" : "DISABLED",
    chainId: configuredChainId === 97 || configuredChainId === 56 ? configuredChainId : null,
    mainnetEnabled: process.env.ENABLE_MAINNET_AGENT_TRADING === "true",
    liveSubmissionEnabled: process.env.ENABLE_LIVE_USEROP_SUBMISSION === "true",
    networkAllowed: network.allowed,
    blockers,
    execution: { signing: enabled && network.allowed, transactionSubmitted: false },
  }, { headers });
}
