import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomyProviderRegistry } from "../services/autonomy/provider-registry.ts";

function adapter(id, options = {}) {
  return {
    id,
    supportedChainIds: options.chains ?? ["56"],
    isConfigured: () => options.configured !== false,
    getQuote: async () => ({ provider: id }),
    getRoundTripQuote: async () => {
      if (options.fail) throw new Error("provider unavailable");
      return { provider: id, buy: { provider: id }, sell: { provider: id } };
    },
    buildOrder: async () => ({ provider: id }),
  };
}

test("provider registry selects the first configured adapter for a supported chain", () => {
  const registry = createAutonomyProviderRegistry([
    adapter("offline", { configured: false }),
    adapter("primary"),
  ], ["offline", "primary"]);
  assert.equal(registry.select("56").id, "primary");
});

test("provider registry skips failed adapters without mixing quote legs", async () => {
  const registry = createAutonomyProviderRegistry([
    adapter("first", { fail: true }),
    adapter("second"),
  ], ["first", "second"]);
  const selected = await registry.getRoundTripQuote({
    chainId: "56", walletAddress: "0x1", inputTokenAddress: "0x2",
    outputTokenAddress: "0x3", amountIn: "100", slippageBps: 50,
    networkFeeBufferBps: 10_000,
  });
  assert.equal(selected.adapter.id, "second");
  assert.equal(selected.result.buy.provider, "second");
  assert.equal(selected.result.sell.provider, "second");
});

test("provider registry fails closed when no adapter supports the chain", () => {
  const registry = createAutonomyProviderRegistry([adapter("bsc-only")], ["bsc-only"]);
  assert.throws(() => registry.select("1"), /No configured autonomy execution provider/);
});

test("provider registry rejects duplicate provider identifiers", () => {
  assert.throws(() => createAutonomyProviderRegistry([
    adapter("duplicate"), adapter("duplicate"),
  ], ["duplicate"]), /must be unique/);
});

test("provider registry rejects provider evidence with a mismatched identity", async () => {
  const invalid = adapter("expected");
  invalid.getRoundTripQuote = async () => ({
    provider: "unexpected", buy: { provider: "unexpected" }, sell: { provider: "unexpected" },
  });
  const registry = createAutonomyProviderRegistry([invalid], ["expected"]);
  await assert.rejects(registry.getRoundTripQuote({
    chainId: "56", walletAddress: "0x1", inputTokenAddress: "0x2",
    outputTokenAddress: "0x3", amountIn: "100", slippageBps: 50,
    networkFeeBufferBps: 10_000,
  }), /All configured quote providers failed/);
});
