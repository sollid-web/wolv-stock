#!/usr/bin/env node
/**
 * Read-only Binance Web3 API capability probe.
 * GET requests only: never signs, submits, broadcasts, or places an order.
 */
import crypto from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const BASE_URL = "https://web3.binance.com/build";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const REQUEST_TIMEOUT_MS = 12_000;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function buildSignedHeaders(method, pathAndQuery, apiKey, secretKey, now = new Date()) {
  if (method !== "GET") throw new TypeError("Probe permits GET requests only.");
  if (typeof pathAndQuery !== "string" || !pathAndQuery.startsWith("/api/") || pathAndQuery.includes("#")) {
    throw new TypeError("Invalid Binance API path.");
  }
  if (!apiKey || !secretKey) throw new Error("BINANCE_API_KEY and BINANCE_SECRET_KEY are required.");
  const timestamp = now.toISOString();
  const preHash = timestamp + method + "/build" + pathAndQuery;
  const signature = crypto.createHmac("sha256", secretKey).update(preHash, "utf8").digest("base64");
  return {
    "X-OC-APIKEY": apiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": signature,
    "X-OC-RECV-WINDOW": "60000",
  };
}

export function parseEnvelope(body, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(label + ": invalid response envelope");
  }
  if (body.code !== 0 || body.success !== true) {
    throw new Error(label + ": Binance business code " + String(body.code) + " (" + String(body.msg ?? "unknown") + ")");
  }
  return body.data;
}

async function signedGet(path, params, credentials, fetchImpl = fetch) {
  const query = new URLSearchParams(params ?? {}).toString();
  const pathAndQuery = query ? path + "?" + query : path;
  const response = await fetchImpl(BASE_URL + pathAndQuery, {
    method: "GET",
    headers: buildSignedHeaders("GET", pathAndQuery, credentials.apiKey, credentials.secretKey),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(path + ": response was not valid JSON (HTTP " + response.status + ")"); }
  if (!response.ok) {
    throw new Error(path + ": HTTP " + response.status + ", Binance code " + String(body?.code ?? "unknown") + " (" + String(body?.msg ?? response.statusText) + ")");
  }
  return parseEnvelope(body, path);
}

function report(name, status, details = "") {
  console.log("[" + status + "] " + name + (details ? " — " + details : ""));
}

export async function runReadOnlyProbe(env = process.env, fetchImpl = fetch) {
  const { BINANCE_API_KEY: apiKey, BINANCE_SECRET_KEY: secretKey } = env;
  if (!apiKey || !secretKey) {
    report("Binance Web3 API credentials", "SKIP", "set BINANCE_API_KEY and BINANCE_SECRET_KEY");
    return { skipped: true, checks: [] };
  }
  const credentials = { apiKey, secretKey };
  const checks = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      report(name, "PASS", detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name, ok: false, error: message });
      report(name, "FAIL", message);
    }
  };

  let assets = [];
  await run("RWA token catalogue", async () => {
    const data = await signedGet("/api/v1/dex/market/rwa/tokens", {}, credentials, fetchImpl);
    if (!Array.isArray(data)) throw new Error("expected data[]");
    assets = data.filter((item) => item?.binanceChainId === "56" && ADDRESS_RE.test(item?.tokenContractAddress ?? ""));
    if (!assets.length) throw new Error("no valid BSC RWA token returned");
    return assets.length + " BSC token(s)";
  });

  const selected = env.BINANCE_PROBE_TOKEN_ADDRESS
    ? assets.find((item) => item.tokenContractAddress.toLowerCase() === env.BINANCE_PROBE_TOKEN_ADDRESS.toLowerCase())
    : (assets.find((item) => item.statusInfo?.openState === true) ?? assets[0]);

  if (selected) {
    await run("RWA token price", async () => {
      const data = await signedGet("/api/v1/dex/market/rwa/price", {
        binanceChainId: "56", tokenContractAddresses: selected.tokenContractAddress,
      }, credentials, fetchImpl);
      if (data == null) throw new Error("missing price payload");
      return "price endpoint returned data";
    });
    await run("Underlying market data", async () => {
      const data = await signedGet("/api/v1/dex/market/rwa/underlying-market", {
        binanceChainId: "56", tokenContractAddress: selected.tokenContractAddress,
      }, credentials, fetchImpl);
      if (!data || typeof data !== "object") throw new Error("missing market data payload");
      return String(selected.underlyingTicker ?? selected.tokenSymbol ?? "selected token");
    });
    if (env.BINANCE_PROBE_WALLET_ADDRESS) {
      await run("Aggregator quote (read-only)", async () => {
        const wallet = env.BINANCE_PROBE_WALLET_ADDRESS;
        if (!ADDRESS_RE.test(wallet)) throw new Error("BINANCE_PROBE_WALLET_ADDRESS is not an EVM address");
        const data = await signedGet("/api/v1/dex/aggregator/quote", {
          binanceChainId: "56",
          fromTokenAddress: USDT_BSC,
          toTokenAddress: selected.tokenContractAddress,
          amount: "100000000000000000000",
          userWalletAddress: wallet,
        }, credentials, fetchImpl);
        if (!data || typeof data !== "object") throw new Error("missing quote payload");
        return "quote returned; no transaction was built or submitted";
      });
    } else {
      report("Aggregator quote (read-only)", "SKIP", "set BINANCE_PROBE_WALLET_ADDRESS");
    }
  } else if (env.BINANCE_PROBE_TOKEN_ADDRESS) {
    checks.push({ name: "Selected BSC token", ok: false, error: "configured token not found in BSC RWA catalogue" });
    report("Selected BSC token", "FAIL", "configured token not found in catalogue");
  }
  return { skipped: false, checks, ok: checks.length > 0 && checks.every((item) => item.ok) };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const result = await runReadOnlyProbe();
    if (result.skipped) process.exitCode = 2;
    else if (!result.ok) process.exitCode = 1;
    else report("Read-only Binance provider probe", "PASS", "all executed checks passed");
  } catch (error) {
    report("Read-only Binance provider probe", "FAIL", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
