import test from "node:test";
import assert from "node:assert/strict";
import { createNormalizedProviderRegistry } from "../services/autonomy/normalized-provider-registry.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";
const request = {
  chainId: "56", walletAddress: wallet, inputTokenAddress: inputToken,
  outputTokenAddress: outputToken, amountIn: "1000", slippageBps: 50,
};

function adapter(id, quoteOverride = {}) {
  return {
    id,
    supportedChainIds: ["56"],
    isConfigured: () => true,
    async getQuote() {
      return {
        provider: id, chainId: "56", walletAddress: wallet,
        inputTokenAddress: inputToken, outputTokenAddress: outputToken,
        amountIn: "1000", expectedAmountOut: "900",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        routeFingerprint: "route-hash", rawEvidenceRef: "evidence-hash",
        tokenMetadata: { inputDecimals: 18, outputDecimals: 18 },
        providerEvidence: {}, ...quoteOverride,
      };
    },
    async prepareExecution({ quote }) {
      if (quote.provider !== id) throw new Error("cross-provider quote rejected");
      return { kind: "TEST", provider: id };
    },
  };
}

test("normalized registry selects configured provider in explicit preference order", () => {
  const first = adapter("first");
  const second = adapter("second");
  const registry = createNormalizedProviderRegistry([first, second], ["second", "first"]);
  assert.equal(registry.select("56").id, "second");
  assert.deepEqual(registry.listAvailable("1"), []);
});

test("normalized registry binds returned quote to exact request", async () => {
  const registry = createNormalizedProviderRegistry([adapter("first")], ["first"]);
  const { adapter: selected, quote } = await registry.getQuote(request);
  assert.equal(selected.id, "first");
  assert.equal(quote.amountIn, request.amountIn);
  assert.equal(quote.walletAddress, wallet);
});

test("normalized registry rejects a provider response for another wallet or amount", async () => {
  const badWallet = adapter("bad-wallet", {
    walletAddress: "0x9999999999999999999999999999999999999999",
  });
  const registry = createNormalizedProviderRegistry([badWallet], ["bad-wallet"]);
  await assert.rejects(registry.getQuote(request), /All normalized quote providers failed/);
});

test("normalized registry may fall back before quote acceptance but never mixes provider evidence", async () => {
  const failing = { ...adapter("failing"), async getQuote() { throw new Error("provider offline"); } };
  const second = adapter("second");
  const registry = createNormalizedProviderRegistry([failing, second], ["failing", "second"]);
  const { adapter: selected, quote } = await registry.getQuote(request);
  assert.equal(selected.id, "second");
  assert.equal(quote.provider, "second");
  await assert.rejects(adapter("first").prepareExecution({ quote, slippageBps: 50, maxPriceImpactBps: 100 }),
    /cross-provider quote rejected/);
});

test("normalized registry fails closed when no provider supports the requested chain", async () => {
  const registry = createNormalizedProviderRegistry([adapter("bsc")], ["bsc"]);
  await assert.rejects(registry.getQuote({ ...request, chainId: "1" }), /No configured normalized execution provider/);
});
