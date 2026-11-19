import { createAgentPublicClient, getAgentSmartAccountConfig } from "@/lib/smartAccount";
import { parseSimulationInput, simulateAgentDecision, SimulationInputError } from "@/lib/agentSimulation";
import { fetchMarketData } from "@/services/agentMarketData";
import type { MarketSnapshot } from "@/services/agentWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };
const MARKET_CACHE_MS = 10_000;
const MARKET_PROBE_BNB = BigInt("1000000000000000"); // 0.001 BNB
const marketCache = new Map<string, { at: number; snapshot: Promise<MarketSnapshot> }>();

/**
 * Read-only simulation of one agent decision: the production decision logic, the live testnet
 * market, and a hypothetical policy from the request. It never signs, submits, or trades.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: HEADERS });
  }
  let input;
  try {
    input = parseSimulationInput(body);
  } catch (error) {
    if (error instanceof SimulationInputError) return Response.json({ error: error.message }, { status: 422, headers: HEADERS });
    throw error;
  }
  try {
    const config = getAgentSmartAccountConfig();
    const client = createAgentPublicClient(config);
    const result = await simulateAgentDecision(input, config.targetTokenAddress, (strategy) => {
      // Price and reserves do not depend on trade size; read them with a small probe so the
      // production decision logic (not the reader) evaluates price impact for the real amount.
      const key = "market";
      const cached = marketCache.get(key);
      if (cached && Date.now() - cached.at < MARKET_CACHE_MS) return cached.snapshot;
      const probe = { ...strategy, amountBnb: MARKET_PROBE_BNB, slippageBps: 500, maxPriceImpactBps: 500 };
      const snapshot = fetchMarketData(probe, config, client);
      marketCache.set(key, { at: Date.now(), snapshot });
      snapshot.catch(() => marketCache.delete(key));
      return snapshot;
    });
    return Response.json({ ...result, chainId: config.chain.id, targetToken: config.targetTokenAddress }, { headers: HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Simulation failed.";
    return Response.json({ error: `Live market data is unavailable: ${message.slice(0, 160)}` }, { status: 503, headers: HEADERS });
  }
}
