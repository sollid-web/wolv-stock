import { handleAgentRunGet, handleAgentRunPost } from "@/services/agentControlHttp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleAgentRunGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleAgentRunPost(request);
}
