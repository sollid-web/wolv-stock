export interface LiveExecutionPolicy {
  ownerId: string;
  walletAddress: string;
  chainId: string;
  inputTokenAddress: string;
  policyVersion: string;
  enabled: boolean;
  emergencyStop: boolean;
  globalKillSwitch: boolean;
  allowedChainIds: string[];
  allowedTokenAddresses: string[];
  allowedInputTokenAddresses: string[];
  budgetAmount: string;
  reservedAmount: string;
  committedAmount: string;
  dailySpendAmount: string;
  dailySpendDate: string;
  maxOrderAmount: string;
  maxPositionAmount: string;
  maxDailySpend: string;
  maxOpenPositions: number;
  maxOpenOrders: number;
  maxDailyRealizedLoss: string;
  minNativeGasBalanceWei: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxQuoteAgeMs: number;
  maxGasCostUsd: string;
  minExpectedEdgeBps: number;
}

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and service-role key are required for live portfolio policy.");
  return { url, key };
}

async function request(path: string) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error("Live portfolio policy request failed (" + response.status + "): " + (await response.text()).slice(0, 300));
  }
  return response.json() as Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Live portfolio policy has invalid " + field);
  return value;
}

function decimal(value: unknown, field: string): string {
  const result = String(value);
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(result)) {
    throw new Error("Live portfolio policy has invalid " + field);
  }
  return result;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error("Live portfolio policy has invalid " + field);
  }
  return result;
}

function address(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^0x[0-9a-f]{40}$/i.test(result)) throw new Error("Live portfolio policy has invalid " + field);
  return result.toLowerCase();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Live portfolio policy has invalid " + field);
  }
  return value.map((item) => String(item).trim());
}

function addressList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^0x[0-9a-f]{40}$/i.test(item))) {
    throw new Error("Live portfolio policy has invalid " + field);
  }
  return value.map((item) => String(item).toLowerCase());
}

export async function loadLiveExecutionPolicy(ownerId: string): Promise<LiveExecutionPolicy | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new Error("Live portfolio owner ID must be a UUID");
  }

  const query = new URLSearchParams({
    select: [
      "owner_id", "wallet_address", "chain_id", "input_token_address", "policy_version",
      "live_enabled", "live_emergency_stop", "emergency_stop",
      "allowed_chain_ids", "allowed_token_addresses", "allowed_input_token_addresses",
      "live_budget_amount_text:live_budget_amount::text",
      "live_reserved_amount_text:live_reserved_amount::text",
      "live_committed_amount_text:live_committed_amount::text",
      "live_daily_spend_amount_text:live_daily_spend_amount::text",
      "live_daily_spend_date",
      "live_max_order_amount_text:live_max_order_amount::text",
      "live_max_position_amount_text:live_max_position_amount::text",
      "live_max_daily_spend_text:live_max_daily_spend::text",
      "live_max_open_positions", "live_max_open_orders",
      "live_max_daily_realized_loss_text:live_max_daily_realized_loss::text",
      "live_min_native_gas_balance_wei_text:live_min_native_gas_balance_wei::text",
      "live_max_slippage_bps", "live_max_price_impact_bps",
      "live_max_quote_age_ms", "live_max_gas_cost_usd_text:live_max_gas_cost_usd::text",
      "live_min_expected_edge_bps",
    ].join(","),
    owner_id: "eq." + ownerId,
    limit: "1",
  });

  const rows = await request("wolv_autonomy_portfolios?" + query) as unknown;
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid live portfolio policy response");
  if (!rows.length) return null;
  if (rows.length !== 1 || !record(rows[0])) throw new Error("Supabase returned duplicate or malformed live portfolio policy rows");
  const row = rows[0];

  const controlRows = await request("wolv_autonomy_global_control?select=kill_switch&singleton=eq.true&limit=1") as unknown;
  if (!Array.isArray(controlRows) || controlRows.length !== 1 || !record(controlRows[0]) ||
      typeof controlRows[0].kill_switch !== "boolean") {
    throw new Error("Global autonomy kill switch is missing or malformed");
  }

  if (typeof row.live_enabled !== "boolean" ||
      typeof row.live_emergency_stop !== "boolean" ||
      typeof row.emergency_stop !== "boolean") {
    throw new Error("Live portfolio policy has invalid enable/stop flags");
  }

  const policy: LiveExecutionPolicy = {
    ownerId,
    walletAddress: address(row.wallet_address, "wallet_address"),
    chainId: text(row.chain_id, "chain_id"),
    inputTokenAddress: address(row.input_token_address, "input_token_address"),
    policyVersion: text(row.policy_version, "policy_version"),
    enabled: row.live_enabled,
    emergencyStop: row.live_emergency_stop || row.emergency_stop,
    globalKillSwitch: controlRows[0].kill_switch,
    allowedChainIds: stringList(row.allowed_chain_ids, "allowed_chain_ids"),
    allowedTokenAddresses: addressList(row.allowed_token_addresses, "allowed_token_addresses"),
    allowedInputTokenAddresses: addressList(row.allowed_input_token_addresses, "allowed_input_token_addresses"),
    budgetAmount: decimal(row.live_budget_amount_text, "live_budget_amount"),
    reservedAmount: decimal(row.live_reserved_amount_text, "live_reserved_amount"),
    committedAmount: decimal(row.live_committed_amount_text, "live_committed_amount"),
    dailySpendAmount: decimal(row.live_daily_spend_amount_text, "live_daily_spend_amount"),
    dailySpendDate: text(row.live_daily_spend_date, "live_daily_spend_date"),
    maxOrderAmount: decimal(row.live_max_order_amount_text, "live_max_order_amount"),
    maxPositionAmount: decimal(row.live_max_position_amount_text, "live_max_position_amount"),
    maxDailySpend: decimal(row.live_max_daily_spend_text, "live_max_daily_spend"),
    maxOpenPositions: integer(row.live_max_open_positions, "live_max_open_positions", 1, 100),
    maxOpenOrders: integer(row.live_max_open_orders, "live_max_open_orders", 1, 100),
    maxDailyRealizedLoss: decimal(row.live_max_daily_realized_loss_text, "live_max_daily_realized_loss"),
    minNativeGasBalanceWei: decimal(row.live_min_native_gas_balance_wei_text, "live_min_native_gas_balance_wei"),
    maxSlippageBps: integer(row.live_max_slippage_bps, "live_max_slippage_bps", 0, 5000),
    maxPriceImpactBps: integer(row.live_max_price_impact_bps, "live_max_price_impact_bps", 0, 10000),
    maxQuoteAgeMs: integer(row.live_max_quote_age_ms, "live_max_quote_age_ms", 0, 3600000),
    maxGasCostUsd: decimal(row.live_max_gas_cost_usd_text, "live_max_gas_cost_usd"),
    minExpectedEdgeBps: integer(row.live_min_expected_edge_bps, "live_min_expected_edge_bps", -10000, 100000),
  };

  if (policy.enabled && (
    policy.globalKillSwitch || policy.emergencyStop || policy.chainId !== "56" ||
    !policy.allowedChainIds.includes("56") ||
    policy.budgetAmount === "0" || policy.maxOrderAmount === "0" ||
    policy.maxPositionAmount === "0" || policy.maxDailySpend === "0" ||
    policy.maxDailyRealizedLoss === "0" || policy.maxQuoteAgeMs === 0 ||
    policy.maxGasCostUsd === "0" || !policy.allowedTokenAddresses.length ||
    !policy.allowedInputTokenAddresses.length
  )) {
    throw new Error("Live portfolio is enabled with incomplete, stopped or zero-limit risk policy");
  }
  return policy;
}
