import { handleAgentTransactionSimulationPost } from "@/services/agentTransactionSimulation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAgentTransactionSimulationPost(request);
}
