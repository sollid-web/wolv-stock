import crypto from "crypto";

const QUOTE_BINDING_TTL_MS = 30_000;

type QuoteBindingPayload = {
  toToken: string;
  amount: string;
  wallet: string;
  quoteId: string;
  issuedAt: number;
};

function bindingSecret(): string {
  const secret = process.env.BINANCE_SECRET_KEY;
  if (!secret) throw new Error("Quote binding secret is not configured");
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", bindingSecret()).update(payload, "utf8").digest("base64url");
}

export function createQuoteBinding(input: Omit<QuoteBindingPayload, "issuedAt">, issuedAt = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...input, issuedAt }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyQuoteBinding(
  binding: string,
  expected: Omit<QuoteBindingPayload, "issuedAt">
): { ok: true; issuedAt: number } | { ok: false; reason: string } {
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(binding)) {
      return { ok: false, reason: "Malformed quote binding" };
    }
    const [encodedPayload, providedSignature] = binding.split(".");
    const expectedSignature = sign(encodedPayload);
    const provided = Buffer.from(providedSignature, "base64url");
    const expectedBytes = Buffer.from(expectedSignature, "base64url");
    if (provided.length !== expectedBytes.length || !crypto.timingSafeEqual(provided, expectedBytes)) {
      return { ok: false, reason: "Quote binding signature mismatch" };
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<QuoteBindingPayload>;
    if (
      typeof payload.toToken !== "string" ||
      typeof payload.amount !== "string" ||
      typeof payload.wallet !== "string" ||
      typeof payload.quoteId !== "string" ||
      typeof payload.issuedAt !== "number"
    ) {
      return { ok: false, reason: "Incomplete quote binding" };
    }
    if (Date.now() - payload.issuedAt < 0 || Date.now() - payload.issuedAt >= QUOTE_BINDING_TTL_MS) {
      return { ok: false, reason: "Quote binding expired" };
    }
    if (
      payload.toToken.toLowerCase() !== expected.toToken.toLowerCase() ||
      payload.amount !== expected.amount ||
      payload.wallet.toLowerCase() !== expected.wallet.toLowerCase() ||
      payload.quoteId !== expected.quoteId
    ) {
      return { ok: false, reason: "Quote binding does not match this trade" };
    }
    return { ok: true, issuedAt: payload.issuedAt };
  } catch {
    return { ok: false, reason: "Invalid quote binding" };
  }
}
