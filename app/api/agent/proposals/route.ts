import { handleAgentProposalPost } from "@/services/agentControlHttp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAgentProposalPost(request);
}
