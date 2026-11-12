import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../supabase/migrations/20261111100000_create_paper_exit_ledger.sql", import.meta.url), "utf8");

test("paper exit policy defaults disabled and requires at least one configured threshold", () => {
  assert.match(migration, /paper_exit_enabled boolean not null default false/);
  assert.match(migration, /paper_take_profit_bps is not null or paper_stop_loss_bps is not null or paper_max_holding_ms is not null/);
});
test("paper exit ledger is owner-scoped and idempotent", () => {
  assert.match(migration, /unique\(owner_id, exit_intent_id\)/);
  assert.match(migration, /unique\(owner_id, quote_id\)/);
  assert.match(migration, /for update/);
});
test("paper exit commits reduce position and committed paper capital atomically", () => {
  assert.match(migration, /delete from public\.wolv_autonomy_positions/);
  assert.match(migration, /cost_basis_input_units = greatest\(0, cost_basis_input_units - basis_released\)/);
  assert.match(migration, /committed_amount = greatest\(0, committed_amount - basis_released\)/);
});
test("entry emergency stop does not block an explicitly configured risk-reducing exit", () => {
  assert.match(migration, /if not found or not account\.paper_exit_enabled then return false; end if;/);
  assert.doesNotMatch(migration, /not account\.paper_exit_enabled or account\.emergency_stop/);
});
test("paper exit RPC is unavailable to browser roles", () => {
  assert.match(migration, /revoke all on function public\.wolv_commit_autonomy_paper_exit[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.wolv_commit_autonomy_paper_exit[\s\S]*to service_role/);
});
