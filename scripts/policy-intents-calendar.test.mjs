import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  hashPolicyIntent,
  validatePolicyExecutionIntent,
  verifyPolicyIntentSignature,
} from "../services/policyIntent.ts";
import { fetchVerifiedUsMarketCalendar, UsMarketCalendarError } from "../services/usMarketCalendar.ts";

test("policy intent accepts a valid owner signature and rejects tampering", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const intent = {
    intentType: "WOLV_TESTNET_TRADE_INTENT",
    version: 1,
    ownerAddress: account.address,
    chainId: 97,
    smartAccountAddress: "0x1111111111111111111111111111111111111111",
    policyHash: "a".repeat(64),
    targetTokenAddress: "0x2222222222222222222222222222222222222222",
    direction: "BUY",
    amountWei: "100000000000000000",
    slippageBps: 100,
    maxPriceImpactBps: 300,
    expiresAt: Date.now() + 60_000,
    nonce: "nonce-1234567890",
  };
  const { createPolicyIntentMessage } = await import("../services/policyIntent.ts");
  const signature = await account.signMessage({ message: createPolicyIntentMessage(intent) });
  const verified = await verifyPolicyIntentSignature(intent, signature);
  assert.equal(verified.ok, true);
  assert.match(hashPolicyIntent(intent), /^[a-f0-9]{64}$/);
  assert.equal(validatePolicyExecutionIntent({ ...intent, chainId: 56 }, Date.now()).length > 0, true);

  const tampered = await verifyPolicyIntentSignature({ ...intent, amountWei: "200000000000000000" }, signature);
  assert.equal(tampered.ok, false);
});

test("US market calendar rejects missing configuration and malformed providers", async () => {
  const oldUrl = process.env.WOLV_US_MARKET_CALENDAR_URL;
  delete process.env.WOLV_US_MARKET_CALENDAR_URL;
  await assert.rejects(
    () => fetchVerifiedUsMarketCalendar("2026-11-03", Date.now()),
    (error) => error instanceof UsMarketCalendarError && error.code === "NOT_CONFIGURED",
  );
  process.env.WOLV_US_MARKET_CALENDAR_URL = "https://calendar.example.test/us";
  await assert.rejects(
    () => fetchVerifiedUsMarketCalendar("2026-11-03", Date.now(), async () => new Response("{", { status: 200 })),
    (error) => error instanceof UsMarketCalendarError && error.code === "MALFORMED",
  );
  if (oldUrl) process.env.WOLV_US_MARKET_CALENDAR_URL = oldUrl;
  else delete process.env.WOLV_US_MARKET_CALENDAR_URL;
});

test("US market calendar parses a representative verified provider response", async () => {
  process.env.WOLV_US_MARKET_CALENDAR_URL = "https://calendar.example.test/us";
  const now = Date.now();
  const result = await fetchVerifiedUsMarketCalendar("2026-11-03", now, async () =>
    new Response(JSON.stringify({
      days: [{
        date: "2026-11-03",
        session: "OPEN",
        sessionStartUtcMinutes: 870,
        sessionEndUtcMinutes: 1260,
        providerTimestamp: new Date(now).toISOString(),
      }],
    }), { status: 200 }));
  assert.equal(result.session, "OPEN");
  assert.equal(result.sessionStartUtcMinutes, 870);
  delete process.env.WOLV_US_MARKET_CALENDAR_URL;
});
