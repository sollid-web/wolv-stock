import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/20261112193107_extend_paper_fill_exit_evidence.sql", import.meta.url), "utf8");

test("paper fills persist both RFQ legs, conservative outputs and fee evidence", () => {
  assert.match(sql, /add column if not exists sell_quote_id text/);
  assert.match(sql, /expected_exit_amount_out numeric/);
  assert.match(sql, /roundtrip_edge_bps integer/);
  assert.match(sql, /buffered_network_fees_usd numeric/);
  assert.match(sql, /exit_quote_observed_at timestamptz/);
  assert.match(sql, /slippage_bps integer/);
});

test("atomic paper commit validates both quote IDs and all round-trip evidence", () => {
  assert.match(sql, /drop function if exists public\.wolv_commit_autonomy_paper_fill/);
  assert.match(sql, /e\.value->'detail'->>'buyQuoteId' = p_quote_id/);
  assert.match(sql, /e\.value->'detail'->>'sellQuoteId' = p_sell_quote_id/);
  assert.match(sql, /expectedExitAmountOut/);
  assert.match(sql, /indicativeRoundTripEdgeBps/);
  assert.match(sql, /bufferedNetworkFeesUsd/);
  assert.match(sql, /slippageBps/);
  assert.match(sql, /p_exit_quote_observed_at/);
  assert.match(sql, /grant execute on function public\.wolv_commit_autonomy_paper_fill/);
});
