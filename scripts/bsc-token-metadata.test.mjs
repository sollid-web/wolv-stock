import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom } from "viem";
import { bsc } from "viem/chains";
import { BSC_USDT_ADDRESS } from "../lib/apiValidation.ts";
import {
  resolveBscTokenMetadata,
  selectTrustedBawSpotAsset,
} from "../services/bscTokenMetadata.ts";

const TOKEN = "0x0000000000000000000000000000000000000123";
const OTHER = "0x0000000000000000000000000000000000000456";
const BLOCK = 0x1234n;

function catalogue(tokenAddress = TOKEN, overrides = {}) {
  return {
    data: [{
      tokenContractAddress: tokenAddress,
      underlyingTicker: "AAPL",
      platformId: "bStock",
      symbol: "AAPLB",
      referencePrice: "100",
      tokenToShareRatio: "1",
      statusInfo: { marketStatus: "open", openState: true },
      ...overrides,
    }],
  };
}

function rpcHarness(options = {}) {
  const calls = [];
  const values = new Map([
    [TOKEN.toLowerCase(), options.tokenDecimals ?? 8],
    [OTHER.toLowerCase(), options.otherDecimals ?? 6],
    [BSC_USDT_ADDRESS.toLowerCase(), options.usdtDecimals ?? 18],
  ]);
  const client = createPublicClient({
    chain: bsc,
    transport: custom({
      async request({ method, params }) {
        calls.push({ method, params });
        if (method === "eth_chainId") return options.chainId ?? "0x38";
        if (method === "eth_blockNumber") return "0x1234";
        if (method === "eth_getCode") {
          const address = params[0].toLowerCase();
          if (options.noCode?.has(address)) return "0x";
          return address === TOKEN.toLowerCase() && options.proxyCode
            ? "0x60006000"
            : "0x6080604052";
        }
        if (method === "eth_call") {
          const address = params[0].to.toLowerCase();
          if (options.revert?.has(address)) throw new Error("execution reverted");
          if (options.malformed?.has(address)) return "0x12";
          if (options.readFailure?.has(address)) throw new Error("RPC unavailable");
          const value = values.get(address);
          if (value === undefined) throw new Error("unexpected token address");
          return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    }),
  });
  return { client, calls, values };
}

function resolve(tokenAddress = TOKEN, options = {}) {
  const rpc = options.rpc ?? rpcHarness(options);
  const record = catalogue(tokenAddress).data[0];
  const trustedAsset = selectTrustedBawSpotAsset([record], tokenAddress);
  assert.ok(trustedAsset);
  return {
    rpc,
    promise: resolveBscTokenMetadata(trustedAsset, {
      client: rpc.client,
      now: () => options.now ?? 1_800_000_000_000,
    }),
  };
}

test("resolves selected-token and USDT decimals independently at one BSC block", async (t) => {
  for (const decimals of [0, 6, 8, 18]) {
    await t.test(`${decimals} selected-token decimals`, async () => {
      const { promise, rpc } = resolve(TOKEN, { tokenDecimals: decimals, usdtDecimals: 6 });
      const metadata = await promise;
      assert.equal(metadata.token.decimals, decimals);
      assert.equal(metadata.token.tokenAddress.toLowerCase(), TOKEN.toLowerCase());
      assert.equal(metadata.token.chainId, "56");
      assert.equal(metadata.token.resolutionSource, "BSC_ETH_CALL");
      assert.equal(metadata.token.blockNumber, BLOCK.toString());
      assert.equal(metadata.token.resolvedAt, 1_800_000_000_000);
      assert.equal(metadata.token.validationStatus, "VALIDATED");
      assert.equal(metadata.usdt.decimals, 6);
      assert.equal(metadata.usdt.tokenAddress.toLowerCase(), BSC_USDT_ADDRESS.toLowerCase());

      const calls = rpc.calls.filter((call) => call.method === "eth_call");
      assert.equal(calls.length, 2);
      assert.ok(rpc.calls
        .filter((call) => call.method === "eth_getCode" || call.method === "eth_call")
        .every((call) => call.params[1] === "0x1234"));
      assert.deepEqual(new Set(calls.map((call) => call.params[0].to.toLowerCase())), new Set([
        TOKEN.toLowerCase(),
        BSC_USDT_ADDRESS.toLowerCase(),
      ]));
      assert.ok(rpc.calls.every(({ method }) => [
        "eth_chainId", "eth_blockNumber", "eth_getCode", "eth_call",
      ].includes(method)));
    });
  }
});

test("catalogue selection rejects invalid, absent, duplicate, or ineligible assets before RPC", async (t) => {
  await t.test("invalid address", async () => {
    assert.equal(selectTrustedBawSpotAsset(catalogue().data, "not-an-address"), null);
  });

  await t.test("valid address absent from catalogue", async () => {
    assert.equal(selectTrustedBawSpotAsset(catalogue(OTHER).data, TOKEN), null);
  });

  await t.test("duplicate catalogue address", async () => {
    assert.equal(selectTrustedBawSpotAsset([...catalogue().data, ...catalogue().data], TOKEN), null);
  });

  await t.test("ineligible catalogue identity", async () => {
    const records = catalogue(TOKEN, { underlyingTicker: "SOXL" }).data;
    assert.equal(selectTrustedBawSpotAsset(records, TOKEN), null);
  });
});

test("metadata resolution refuses an unbranded caller-provided asset object", async () => {
  const rpc = rpcHarness();
  await assert.rejects(
    resolveBscTokenMetadata({
      tokenContractAddress: TOKEN,
      underlyingTicker: "AAPL",
      platformId: "bStock",
    }, { client: rpc.client }),
    /not a valid, eligible BSC catalogue token/,
  );
  assert.equal(rpc.calls.length, 0);
});

test("rejects a wrong chain before querying contract data", async () => {
  const { promise, rpc } = resolve(TOKEN, { chainId: "0x61" });
  await assert.rejects(promise, /not connected to BNB Smart Chain mainnet/);
  assert.deepEqual(rpc.calls.map(({ method }) => method), ["eth_chainId"]);
});

test("missing contract code rejects the metadata pair", async (t) => {
  for (const address of [TOKEN, BSC_USDT_ADDRESS]) {
    await t.test(address, async () => {
      const { promise } = resolve(TOKEN, { noCode: new Set([address.toLowerCase()]) });
      await assert.rejects(promise, /No deployed contract code exists/);
    });
  }
});

test("reverted and malformed decimals() calls fail closed", async (t) => {
  for (const [label, option] of [
    ["revert", "revert"],
    ["malformed return data", "malformed"],
  ]) {
    await t.test(label, async () => {
      const { promise } = resolve(TOKEN, { [option]: new Set([TOKEN.toLowerCase()]) });
      await assert.rejects(promise, /decimals\(\) read failed/);
    });
  }
});

test("uint8 decimal values outside WOLV's supported arithmetic range are rejected", async (t) => {
  for (const decimals of [19, 255]) {
    await t.test(`${decimals} decimals`, async () => {
      const { promise } = resolve(TOKEN, { tokenDecimals: decimals });
      await assert.rejects(promise, /outside WOLV's supported range/);
    });
  }
});

test("proxy contracts resolve decimals through the catalogue proxy address", async () => {
  const { promise, rpc } = resolve(TOKEN, { proxyCode: true, tokenDecimals: 8 });
  const metadata = await promise;
  assert.equal(metadata.token.decimals, 8);
  const tokenCall = rpc.calls.find((call) =>
    call.method === "eth_call" && call.params[0].to.toLowerCase() === TOKEN.toLowerCase()
  );
  assert.ok(tokenCall);
  assert.equal(tokenCall.params[0].data, "0x313ce567");
});

test("metadata resolution has no cache and never falls back after a failed refresh", async () => {
  const rpc = rpcHarness({ tokenDecimals: 6 });
  const asset = selectTrustedBawSpotAsset(catalogue().data, TOKEN);
  assert.ok(asset);
  const dependencies = { client: rpc.client, now: () => 1_800_000_000_000 };
  const first = await resolveBscTokenMetadata(asset, dependencies);
  assert.equal(first.token.decimals, 6);

  rpc.values.set(TOKEN.toLowerCase(), 8);
  dependencies.now = () => 1_800_000_061_000;
  const refreshed = await resolveBscTokenMetadata(asset, dependencies);
  assert.equal(refreshed.token.decimals, 8);
  assert.equal(rpc.calls.filter((call) => call.method === "eth_call").length, 4);

  rpc.values.delete(TOKEN.toLowerCase());
  await assert.rejects(
    resolveBscTokenMetadata(asset, dependencies),
    /decimals\(\) read failed/,
  );
});
