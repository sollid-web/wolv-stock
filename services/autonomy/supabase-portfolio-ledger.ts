import type { RiskPolicy } from "./execution-domain";

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and service-role key are required for the autonomy portfolio ledger.");
  return { url, key };
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Autonomy portfolio request failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

export type PortfolioPolicySnapshot = {
  ownerId: string;
  walletAddress: string;
  chainId: string;
  inputTokenAddress: string;
  policyVersion: string;
  emergencyStop: boolean;
  paperBudgetAmount: string;
  reservedAmount: string;
  committedAmount: string;
  dailySpendAmount: string;
  networkFeeBufferBps: number;
  riskPolicy: RiskPolicy;
};

export async function loadPortfolioPolicy(ownerId: string): Promise<PortfolioPolicySnapshot | null> {
  const query = new URLSearchParams({
    select: [
      "owner_id", "wallet_address", "chain_id", "input_token_address",
      "enabled", "emergency_stop", "policy_version", "allowed_chain_ids",
      "allowed_token_addresses", "allowed_input_token_addresses",
      "paper_budget_amount_text:paper_budget_amount::text", "reserved_amount_text:reserved_amount::text",
      "committed_amount_text:committed_amount::text", "daily_spend_amount_text:daily_spend_amount::text",
      "max_order_amount_text:max_order_amount::text", "max_position_amount_text:max_position_amount::text",
      "max_daily_spend_text:max_daily_spend::text", "max_slippage_bps", "max_price_impact_bps",
      "max_quote_age_ms", "max_gas_cost_usd_text:max_gas_cost_usd::text",
      "network_fee_buffer_bps", "min_expected_edge_bps",
    ].join(","),
    owner_id: `eq.${ownerId}`,
    limit: "1",
  });
  const rows = await request(`wolv_autonomy_portfolios?${query}`) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const strings = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`Portfolio policy has invalid ${field}`);
    }
    return value as string[];
  };
  const numeric = (value: unknown, field: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Portfolio policy has invalid ${field}`);
    return result;
  };
  const decimalString = (value: unknown, field: string): string => {
    const result = String(value);
    if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(result)) throw new Error(`Portfolio policy has invalid ${field}`);
    return result;
  };
  if (typeof row.enabled !== "boolean" || typeof row.emergency_stop !== "boolean") {
    throw new Error("Portfolio policy has invalid enable/stop flags");
  }
  const snapshot: PortfolioPolicySnapshot = {
    ownerId: String(row.owner_id),
    walletAddress: String(row.wallet_address).toLowerCase(),
    chainId: String(row.chain_id),
    inputTokenAddress: String(row.input_token_address).toLowerCase(),
    policyVersion: String(row.policy_version),
    emergencyStop: row.emergency_stop,
    paperBudgetAmount: decimalString(row.paper_budget_amount_text, "paper_budget_amount"),
    reservedAmount: decimalString(row.reserved_amount_text, "reserved_amount"),
    committedAmount: decimalString(row.committed_amount_text, "committed_amount"),
    dailySpendAmount: decimalString(row.daily_spend_amount_text, "daily_spend_amount"),
    networkFeeBufferBps: numeric(row.network_fee_buffer_bps, "network_fee_buffer_bps"),
    riskPolicy: {
      enabled: row.enabled && !row.emergency_stop,
      allowedChainIds: strings(row.allowed_chain_ids, "allowed_chain_ids"),
      allowedTokenAddresses: strings(row.allowed_token_addresses, "allowed_token_addresses"),
      allowedInputTokenAddresses: strings(row.allowed_input_token_addresses, "allowed_input_token_addresses"),
      maxOrderAmount: decimalString(row.max_order_amount_text, "max_order_amount"),
      maxPositionAmount: decimalString(row.max_position_amount_text, "max_position_amount"),
      maxDailySpend: decimalString(row.max_daily_spend_text, "max_daily_spend"),
      maxSlippageBps: numeric(row.max_slippage_bps, "max_slippage_bps"),
      maxPriceImpactBps: numeric(row.max_price_impact_bps, "max_price_impact_bps"),
      maxQuoteAgeMs: numeric(row.max_quote_age_ms, "max_quote_age_ms"),
      maxGasCostUsd: decimalString(row.max_gas_cost_usd_text, "max_gas_cost_usd"),
      minExpectedEdgeBps: Number(row.min_expected_edge_bps),
    },
  };
  if (!Number.isSafeInteger(snapshot.riskPolicy.minExpectedEdgeBps)) {
    throw new Error("Portfolio policy has invalid min_expected_edge_bps");
  }
  return snapshot;
}

export async function reservePortfolioBudget(input: {
  ownerId: string;
  intentId: string;
  chainId: string;
  tokenAddress: string;
  inputTokenAddress: string;
  amountIn: string;
  expectedAmountOut: string;
  policyVersion: string;
}): Promise<boolean> {
  const result = await request("rpc/wolv_reserve_autonomy_budget", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_intent_id: input.intentId,
      p_chain_id: input.chainId,
      p_token_address: input.tokenAddress,
      p_input_token_address: input.inputTokenAddress,
      p_amount_in: input.amountIn,
      p_expected_amount_out: input.expectedAmountOut,
      p_policy_version: input.policyVersion,
    }),
  });
  return result === true;
}

export async function releasePortfolioBudget(ownerId: string, intentId: string): Promise<boolean> {
  const result = await request("rpc/wolv_release_autonomy_budget", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_intent_id: intentId }),
  });
  return result === true;
}

export async function commitPaperQuoteFill(input: {
  ownerId: string;
  intentId: string;
  quoteId: string;
  amountOut: string;
  quoteObservedAt: string;
}): Promise<boolean> {
  const result = await request("rpc/wolv_commit_autonomy_paper_fill", {
    method: "POST",
    body: JSON.stringify({
      p_owner_id: input.ownerId,
      p_intent_id: input.intentId,
      p_quote_id: input.quoteId,
      p_amount_out: input.amountOut,
      p_quote_observed_at: input.quoteObservedAt,
    }),
  });
  return result === true;
}
