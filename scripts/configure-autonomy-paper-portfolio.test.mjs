import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioConfig, configurePortfolio } from "./configure-autonomy-paper-portfolio.mjs";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-secret",
  WOLV_AUTONOMY_OWNER_ID: "11111111-1111-4111-8111-111111111111",
  WOLV_AUTONOMY_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
  WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS: "0x2222222222222222222222222222222222222222",
  WOLV_AUTONOMY_ALLOWED_TOKEN_ADDRESSES: "0x3333333333333333333333333333333333333333",
  WOLV_AUTONOMY_PAPER_BUDGET_BASE_UNITS: "1000000000",
  WOLV_AUTONOMY_MAX_ORDER_BASE_UNITS: "100000000",
  WOLV_AUTONOMY_MAX_POSITION_BASE_UNITS: "500000000",
  WOLV_AUTONOMY_MAX_DAILY_SPEND_BASE_UNITS: "500000000",
  WOLV_AUTONOMY_MAX_SLIPPAGE_BPS: "50",
  WOLV_AUTONOMY_MAX_PRICE_IMPACT_BPS: "100",
  WOLV_AUTONOMY_MAX_QUOTE_AGE_MS: "20000",
  WOLV_AUTONOMY_MAX_GAS_COST_USD: "0.50",
  WOLV_AUTONOMY_NETWORK_FEE_BUFFER_BPS: "10000",
  WOLV_AUTONOMY_MIN_EXPECTED_EDGE_BPS: "100",
};

test("portfolio config defaults disabled and emergency-stopped", () => {
  const row = buildPortfolioConfig(env);
  assert.equal(row.enabled, false);
  assert.equal(row.emergency_stop, true);
  assert.equal(row.chain_id, "56");
  assert.equal(row.paper_budget_amount, "1000000000");
  assert.deepEqual(row.allowed_chain_ids, ["56"]);
});

test("paper mode requires an explicit enable flag", () => {
  const row = buildPortfolioConfig(env, true);
  assert.equal(row.enabled, true);
  assert.equal(row.emergency_stop, false);
});

test("rejects unsafe chain, malformed allowlists and budget-limit inconsistencies", () => {
  assert.throws(() => buildPortfolioConfig({ ...env, WOLV_AUTONOMY_CHAIN_ID: "1" }), /BSC chain 56/);
  assert.throws(() => buildPortfolioConfig({ ...env, WOLV_AUTONOMY_ALLOWED_TOKEN_ADDRESSES: "bad" }), /EVM token addresses/);
  assert.throws(() => buildPortfolioConfig({ ...env, WOLV_AUTONOMY_MAX_ORDER_BASE_UNITS: "600000000" }), /fit inside/);
  assert.throws(() => buildPortfolioConfig({ ...env, WOLV_AUTONOMY_MAX_GAS_COST_USD: "NaN" }), /USD decimal/);
});

test("writes only the owner-scoped policy row using server-side credentials", async () => {
  let captured;
  const result = await configurePortfolio(env, false, async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify([{ owner_id: env.WOLV_AUTONOMY_OWNER_ID }]), { status: 201 });
  });
  assert.equal(result.enabled, false);
  assert.match(captured.url, /wolv_autonomy_portfolios\?on_conflict=owner_id/);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer server-secret");
  assert.equal(captured.body.enabled, false);
  assert.equal(captured.body.emergency_stop, true);
});


test("paper exit rules are disabled by default and can be explicitly configured", () => {
  const disabled = buildPortfolioConfig(env);
  assert.equal(disabled.paper_exit_enabled, false);
  assert.equal(disabled.paper_take_profit_bps, null);
  const enabled = buildPortfolioConfig({
    ...env, WOLV_AUTONOMY_PAPER_TAKE_PROFIT_BPS: "500",
    WOLV_AUTONOMY_PAPER_STOP_LOSS_BPS: "300",
    WOLV_AUTONOMY_PAPER_MAX_HOLDING_MS: "86400000",
  }, true, true);
  assert.equal(enabled.paper_exit_enabled, true);
  assert.equal(enabled.paper_take_profit_bps, 500);
  assert.equal(enabled.paper_stop_loss_bps, 300);
  assert.equal(enabled.paper_max_holding_ms, 86400000);
});

test("paper exits require explicit thresholds and validate their ranges", () => {
  assert.throws(() => buildPortfolioConfig(env, true, true), /At least one paper exit threshold/);
  assert.throws(() => buildPortfolioConfig({ ...env, WOLV_AUTONOMY_PAPER_STOP_LOSS_BPS: "10001" }, true, true), /outside its allowed range/);
});
