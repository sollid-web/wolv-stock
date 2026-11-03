import "server-only";
import { createHash } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";

export type PolicyExecutionIntent = {
  intentType: "WOLV_TESTNET_TRADE_INTENT";
  version: 1;
  ownerAddress: string;
  chainId: 97;
  smartAccountAddress: string;
  policyHash: string;
  targetTokenAddress: string;
  direction: "BUY" | "SELL";
  amountWei: string;
  slippageBps: number;
  maxPriceImpactBps: number;
  expiresAt: number;
  nonce: string;
};

export function createPolicyIntentMessage(intent: PolicyExecutionIntent): string {
  return `WOLV_POLICY_INTENT_V1:${JSON.stringify({
    ...intent,
    ownerAddress: getAddress(intent.ownerAddress),
    smartAccountAddress: getAddress(intent.smartAccountAddress),
    targetTokenAddress: getAddress(intent.targetTokenAddress),
  })}`;
}

export function hashPolicyIntent(intent: PolicyExecutionIntent): string {
  return createHash("sha256").update(createPolicyIntentMessage(intent)).digest("hex");
}

export function validatePolicyExecutionIntent(intent: PolicyExecutionIntent, now = Date.now()) {
  const invalid: string[] = [];
  if (intent.intentType !== "WOLV_TESTNET_TRADE_INTENT" || intent.version !== 1) invalid.push("Unsupported intent type.");
  if (intent.chainId !== 97) invalid.push("Intent is restricted to BSC Testnet.");
  if (![intent.ownerAddress, intent.smartAccountAddress, intent.targetTokenAddress].every((value) => isAddress(value))) {
    invalid.push("Intent addresses are invalid.");
  }
  if (!/^(?:[1-9]\d*)$/.test(intent.amountWei) || BigInt(intent.amountWei) > BigInt("500000000000000000")) {
    invalid.push("Intent amount exceeds the 0.5 BNB limit.");
  }
  if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 1 || intent.slippageBps > 100) {
    invalid.push("Intent slippage is outside the 1-100 bps limit.");
  }
  if (!Number.isInteger(intent.maxPriceImpactBps) || intent.maxPriceImpactBps < 1 || intent.maxPriceImpactBps > 300) {
    invalid.push("Intent price impact is outside the configured limit.");
  }
  if (!/^[a-f0-9]{64}$/.test(intent.policyHash) || !/^[a-zA-Z0-9_-]{16,128}$/.test(intent.nonce)) {
    invalid.push("Intent policy binding or nonce is invalid.");
  }
  if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now || intent.expiresAt > now + 300_000) {
    invalid.push("Intent expiration is invalid or expired.");
  }
  return invalid;
}

export async function verifyPolicyIntentSignature(
  intent: PolicyExecutionIntent,
  signature: string,
  now = Date.now(),
) {
  const invalid = validatePolicyExecutionIntent(intent, now);
  if (invalid.length) return { ok: false as const, reason: invalid.join(" ") };
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) return { ok: false as const, reason: "Intent signature is malformed." };
  const valid = await verifyMessage({
    address: getAddress(intent.ownerAddress),
    message: createPolicyIntentMessage(intent),
    signature: signature as `0x${string}`,
  });
  return valid ? { ok: true as const, intentHash: hashPolicyIntent(intent) } : { ok: false as const, reason: "Intent signature does not match the owner." };
}
