import { getAddress } from "viem";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import {
  verifyPolicyIntentSignature,
  type PolicyExecutionIntent,
} from "@/services/policyIntent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const auth = await authorizeBawWalletRequest(request, process.env.BAW_WALLET_API_TOKEN);
  if (auth !== "authorized") {
    return Response.json(
      { error: auth === "not_configured" ? "Operator wallet access is not configured." : "A valid operator authorization is required." },
      { status: auth === "not_configured" ? 503 : 401, headers: HEADERS },
    );
  }
  const session = await getBawWalletSession(request, process.env.BAW_WALLET_API_TOKEN);
  if (!session) {
    return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: HEADERS });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Intent request must be an object." }, { status: 422, headers: HEADERS });
  }
  const value = body as Record<string, unknown>;
  if (!value.intent || typeof value.intent !== "object" || typeof value.signature !== "string") {
    return Response.json({ error: "Intent and signature are required." }, { status: 422, headers: HEADERS });
  }
  if (Object.keys(value).length !== 2) {
    return Response.json({ error: "Intent request contains unexpected fields." }, { status: 422, headers: HEADERS });
  }

  const intent = value.intent as PolicyExecutionIntent;
  const ownerAddress = intent.ownerAddress;
  let canonicalOwner: string;
  try {
    canonicalOwner = typeof ownerAddress === "string" ? getAddress(ownerAddress) : "";
  } catch {
    return Response.json({ error: "Intent owner address is invalid." }, { status: 422, headers: HEADERS });
  }
  if (!canonicalOwner || canonicalOwner.toLowerCase() !== session.address.toLowerCase()) {
    return Response.json({ error: "Intent owner does not match the connected wallet." }, { status: 403, headers: HEADERS });
  }

  const now = Date.now();
  const verified = await verifyPolicyIntentSignature(intent, value.signature, now);
  if (!verified.ok) {
    return Response.json({ error: verified.reason }, { status: 422, headers: HEADERS });
  }

  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const consumed = await store.consumeIntentNonce({
      ownerAddress: session.address,
      smartAccountAddress: intent.smartAccountAddress,
      nonce: intent.nonce,
      intentHash: verified.intentHash,
      expiresAt: intent.expiresAt,
      consumedAt: now,
    });
    if (!consumed.consumed) {
      return Response.json({ error: "Intent nonce has already been consumed.", code: "INTENT_REPLAY_REJECTED" }, { status: 409, headers: HEADERS });
    }
    return Response.json({
      accepted: true,
      intentHash: verified.intentHash,
      execution: "BLOCKED",
      message: "Signed intent accepted and replay-bound; no transaction was submitted.",
    }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Intent nonce could not be durably recorded." }, { status: 503, headers: HEADERS });
  } finally {
    await store.close();
  }
}
