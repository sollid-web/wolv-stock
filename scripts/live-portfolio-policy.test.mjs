import test from "node:test";
import assert from "node:assert/strict";
import { loadLiveExecutionPolicy } from "../services/autonomy/supabase-live-portfolio-policy.ts";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";
const inputToken = "0x2222222222222222222222222222222222222222";
const outputToken = "0x3333333333333333333333333333333333333333";

function portfolio(overrides = {}) {
  return {
    owner_id: ownerId,
    wallet_address: wallet,
    live_privy_wallet_id: "privy-wallet-123",
    chain_id: "56",
    input_token_address: inputToken,
    policy_version: "live-policy-1",
    live_enabled: false,
    live_emergency_stop: true,
    emergency_stop: true,
    allowed_chain_ids: ["56"],
    allowed_token_addresses: [outputToken],
    allowed_input_token_addresses: [inputToken],
    live_allowed_transaction_senders: [wallet],
    live_allowed_transaction_targets: ["0x4444444444444444444444444444444444444444"],
    live_budget_amount_text: "0",
    live_reserved_amount_text: "0",
    live_committed_amount_text: "0",
    live_daily_spend_amount_text: "0",
    live_daily_spend_date: "2026-11-12",
    live_max_order_amount_text: "0",
    live_max_position_amount_text: "0",
    live_max_daily_spend_text: "0",
    live_max_open_positions: 1,
    live_max_open_orders: 1,
    live_max_daily_realized_loss_text: "0",
    live_min_native_gas_balance_wei_text: "0",
    live_max_slippage_bps: 0,
    live_max_price_impact_bps: 0,
    live_max_quote_age_ms: 0,
    live_max_gas_cost_usd_text: "0",
    live_min_expected_edge_bps: 0,
    network_fee_buffer_bps: 10000,
    ...overrides,
  };
}

function withSupabaseResponses(t, rows, killSwitch = true) {
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = async (url) => {
    const target = String(url);
    const data = target.includes("wolv_autonomy_global_control")
      ? [{ kill_switch: killSwitch }]
      : rows;
    return new Response(JSON.stringify(data), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
}

test("returns null when no live portfolio exists", async (t) => {
  withSupabaseResponses(t, []);
  assert.equal(await loadLiveExecutionPolicy(ownerId), null);
});

test("loads a default-disabled policy and keeps kill switch state explicit", async (t) => {
  withSupabaseResponses(t, [portfolio()], true);
  const policy = await loadLiveExecutionPolicy(ownerId);
  assert.equal(policy.enabled, false);
  assert.equal(policy.globalKillSwitch, true);
  assert.equal(policy.walletAddress, wallet);
  assert.equal(policy.privyWalletId, "privy-wallet-123");
  assert.deepEqual(policy.allowedChainIds, ["56"]);
  assert.deepEqual(policy.allowedTokenAddresses, [outputToken]);
  assert.deepEqual(policy.allowedTransactionSenders, [wallet]);
  assert.deepEqual(policy.allowedTransactionTargets, ["0x4444444444444444444444444444444444444444"]);
});

test("returns an enabled policy with the global stop visible so settlement recovery can continue", async (t) => {
  withSupabaseResponses(t, [portfolio({
    live_enabled: true,
    live_emergency_stop: false,
    emergency_stop: false,
    live_budget_amount_text: "100000",
    live_max_order_amount_text: "10000",
    live_max_position_amount_text: "10000",
    live_max_daily_spend_text: "50000",
    live_max_daily_realized_loss_text: "1000",
    live_max_quote_age_ms: 20000,
    live_max_gas_cost_usd_text: "1",
    live_max_slippage_bps: 100,
    live_max_price_impact_bps: 200,
  })], true);
  const policy = await loadLiveExecutionPolicy(ownerId);
  assert.equal(policy.enabled, true);
  assert.equal(policy.globalKillSwitch, true);
});

test("accepts a complete enabled policy only when the global stop is released", async (t) => {
  withSupabaseResponses(t, [portfolio({
    live_enabled: true,
    live_emergency_stop: false,
    emergency_stop: false,
    live_budget_amount_text: "100000",
    live_max_order_amount_text: "10000",
    live_max_position_amount_text: "10000",
    live_max_daily_spend_text: "50000",
    live_max_daily_realized_loss_text: "1000",
    live_max_quote_age_ms: 20000,
    live_max_gas_cost_usd_text: "1",
    live_max_slippage_bps: 100,
    live_max_price_impact_bps: 200,
  })], false);
  const policy = await loadLiveExecutionPolicy(ownerId);
  assert.equal(policy.enabled, true);
  assert.equal(policy.globalKillSwitch, false);
  assert.equal(policy.maxOrderAmount, "10000");
  assert.equal(policy.minNativeGasBalanceWei, "0");
});
