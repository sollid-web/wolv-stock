#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildPortfolioConfig(env, enablePaper = false) {
  const required = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(key + " is required.");
    return value;
  };
  const integer = (key, min, max) => {
    const raw = required(key);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(key + " must be an integer.");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(key + " is outside its allowed range.");
    return value;
  };
  const units = (key) => {
    const raw = required(key);
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) <= BigInt(0)) throw new Error(key + " must be a positive base-unit integer.");
    return raw;
  };
  const ownerId = required("WOLV_AUTONOMY_OWNER_ID");
  const walletAddress = required("WOLV_AUTONOMY_WALLET_ADDRESS");
  const inputTokenAddress = required("WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS");
  const chainId = env.WOLV_AUTONOMY_CHAIN_ID?.trim() || "56";
  if (!UUID.test(ownerId)) throw new Error("WOLV_AUTONOMY_OWNER_ID must be a UUID.");
  if (!ADDRESS.test(walletAddress) || !ADDRESS.test(inputTokenAddress)) throw new Error("Wallet and input token must be EVM addresses.");
  if (chainId !== "56") throw new Error("This autonomy worker currently supports BSC chain 56 only.");

  const allowedTokens = required("WOLV_AUTONOMY_ALLOWED_TOKEN_ADDRESSES")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!allowedTokens.length || allowedTokens.some((value) => !ADDRESS.test(value))) {
    throw new Error("WOLV_AUTONOMY_ALLOWED_TOKEN_ADDRESSES must contain comma-separated EVM token addresses.");
  }
  const allowedInputs = (env.WOLV_AUTONOMY_ALLOWED_INPUT_TOKEN_ADDRESSES?.trim() || inputTokenAddress)
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!allowedInputs.length || allowedInputs.some((value) => !ADDRESS.test(value)) ||
      !allowedInputs.includes(inputTokenAddress.toLowerCase())) {
    throw new Error("Allowed input tokens must contain the configured input token address.");
  }

  const paperBudget = units("WOLV_AUTONOMY_PAPER_BUDGET_BASE_UNITS");
  const maxOrder = units("WOLV_AUTONOMY_MAX_ORDER_BASE_UNITS");
  const maxPosition = units("WOLV_AUTONOMY_MAX_POSITION_BASE_UNITS");
  const maxDailySpend = units("WOLV_AUTONOMY_MAX_DAILY_SPEND_BASE_UNITS");
  if (BigInt(maxOrder) > BigInt(paperBudget) || BigInt(maxPosition) > BigInt(paperBudget) ||
      BigInt(maxDailySpend) > BigInt(paperBudget) || BigInt(maxOrder) > BigInt(maxDailySpend)) {
    throw new Error("Order, position and daily limits must fit inside the configured paper budget.");
  }

  const maxGasCostUsd = required("WOLV_AUTONOMY_MAX_GAS_COST_USD");
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(maxGasCostUsd)) {
    throw new Error("WOLV_AUTONOMY_MAX_GAS_COST_USD must be a non-negative USD decimal with up to 18 decimals.");
  }

  return {
    owner_id: ownerId,
    wallet_address: walletAddress.toLowerCase(),
    chain_id: chainId,
    input_token_address: inputTokenAddress.toLowerCase(),
    enabled: enablePaper,
    emergency_stop: !enablePaper,
    policy_version: env.WOLV_AUTONOMY_POLICY_VERSION?.trim() || "paper-policy-1",
    allowed_chain_ids: [chainId],
    allowed_token_addresses: [...new Set(allowedTokens)],
    allowed_input_token_addresses: [...new Set(allowedInputs)],
    paper_budget_amount: paperBudget,
    max_order_amount: maxOrder,
    max_position_amount: maxPosition,
    max_daily_spend: maxDailySpend,
    max_slippage_bps: integer("WOLV_AUTONOMY_MAX_SLIPPAGE_BPS", 0, 5000),
    max_price_impact_bps: integer("WOLV_AUTONOMY_MAX_PRICE_IMPACT_BPS", 0, 10000),
    max_quote_age_ms: integer("WOLV_AUTONOMY_MAX_QUOTE_AGE_MS", 1000, 3600000),
    max_gas_cost_usd: maxGasCostUsd,
    network_fee_buffer_bps: integer("WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS", 0, 100000),
    min_expected_edge_bps: integer("WOLV_AUTONOMY_MIN_EXPECTED_EDGE_BPS", 0, 100000),
  };
}

function loadLocalEnv() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

export async function configurePortfolio(env = process.env, enablePaper = false, fetchImpl = fetch) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and server-only service-role key are required.");
  const row = buildPortfolioConfig(env, enablePaper);
  const response = await fetchImpl(url + "/rest/v1/wolv_autonomy_portfolios?on_conflict=owner_id", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Portfolio configuration failed (" + response.status + "): " + (await response.text()).slice(0, 300));
  return { ownerId: row.owner_id, enabled: row.enabled, emergencyStop: row.emergency_stop, policyVersion: row.policy_version };
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  loadLocalEnv();
  const enablePaper = process.argv.includes("--enable-paper");
  try {
    const result = await configurePortfolio(process.env, enablePaper);
    console.log("[autonomy-config] owner=" + result.ownerId + " enabled=" + result.enabled +
      " emergencyStop=" + result.emergencyStop + " policyVersion=" + result.policyVersion);
    if (!enablePaper) console.log("[autonomy-config] safe disabled policy written; pass --enable-paper only after verifying all limits.");
  } catch (error) {
    console.error("[autonomy-config] failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
