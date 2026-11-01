import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

const env = { ...process.env };
for (const line of fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
}

const BASE_URL = "https://web3.binance.com/build";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const DEAD_WALLET = "0x000000000000000000000000000000000000dEaD";
const enabled = env.RUN_REAL_BINANCE_REGRESSION === "1";

async function signedGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac("sha256", env.BINANCE_SECRET_KEY ?? "")
    .update(timestamp + "GET" + "/build" + fullPath, "utf8")
    .digest("base64");
  const response = await fetch(BASE_URL + fullPath, {
    headers: {
      "X-OC-APIKEY": env.BINANCE_API_KEY ?? "",
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-RECV-WINDOW": "60000",
    },
    signal: AbortSignal.timeout(10_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("real Binance provider parses RWA assets and indicative stock quotes", { skip: !enabled }, async () => {
  assert.ok(env.BINANCE_API_KEY, "BINANCE_API_KEY is required for real-provider verification");
  assert.ok(env.BINANCE_SECRET_KEY, "BINANCE_SECRET_KEY is required for real-provider verification");

  const assetList = await signedGet("/api/v1/dex/market/rwa/tokens");
  assert.equal(assetList.status, 200, `Asset-list HTTP status; Binance code ${assetList.body?.code ?? "unknown"}`);
  assert.ok(Array.isArray(assetList.body?.data), "Asset-list data array is required");

  for (const ticker of ["NVDA", "AAPL", "TSLA"]) {
    const assets = assetList.body.data.filter((asset) =>
      String(asset.underlyingTicker ?? "").toUpperCase() === ticker
    );
    assert.ok(assets.length > 0, `${ticker} asset record was not returned`);

    for (const asset of assets.slice(0, 2)) {
      assert.match(String(asset.tokenContractAddress), /^0x[a-fA-F0-9]{40}$/);
      assert.notEqual(Number(asset.tokenToShareRatio), 0);
      assert.notEqual(Number(asset.referencePrice), 0);

      await new Promise((resolve) => setTimeout(resolve, 350));
      const quote = await signedGet("/api/v1/dex/aggregator/quote", {
        binanceChainId: "56",
        fromTokenAddress: USDT_ADDRESS,
        toTokenAddress: asset.tokenContractAddress,
        amount: "100000000000000000000",
        userWalletAddress: DEAD_WALLET,
      });
      assert.equal(quote.status, 200, `${ticker} quote HTTP status; Binance code ${quote.body?.code ?? "unknown"}`);
      const routes = Array.isArray(quote.body?.data) ? quote.body.data : [];
      assert.ok(routes.length > 0, `${ticker} returned no routes`);

      const parsed = routes.map((route) => ({
        executionMode: route.executionMode ?? null,
        fromTokenAddress: route.fromToken?.tokenContractAddress ?? null,
        toTokenAddress: route.toToken?.tokenContractAddress ?? null,
        fromTokenAmount: route.fromTokenAmount ?? null,
        toTokenAmount: route.toTokenAmount ?? null,
        fromTokenDecimals: route.fromToken?.decimal ?? null,
        toTokenDecimals: route.toToken?.decimal ?? null,
        tokenUnitPricePresent: Object.prototype.hasOwnProperty.call(route.fromToken ?? {}, "tokenUnitPrice"),
      }));
      console.log(JSON.stringify({
        realProvider: {
          ticker,
          assetListHttpStatus: assetList.status,
          assetListCode: assetList.body?.code ?? 0,
          tokenAddress: asset.tokenContractAddress,
          quoteHttpStatus: quote.status,
          quoteCode: quote.body?.code ?? 0,
          routeCount: routes.length,
          parsed,
        },
      }));
    }
  }
});
