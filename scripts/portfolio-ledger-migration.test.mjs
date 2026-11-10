import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/20261110150000_create_autonomy_portfolio_ledger.sql", import.meta.url),
  "utf8",
);

test("portfolio defaults fail closed and keep paper budget isolated", () => {
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /emergency_stop boolean not null default true/);
  assert.match(sql, /paper_budget_amount numeric\(78,0\)/);
  assert.match(sql, /reserved_amount \+ committed_amount <= paper_budget_amount/);
});

test("budget reservation enforces allowlists, portfolio caps and risk-approved intent", () => {
  assert.match(sql, /wolv_reserve_autonomy_budget/);
  assert.match(sql, /intent->>'state' = 'RISK_APPROVED'/);
  assert.match(sql, /account\.max_order_amount/);
  assert.match(sql, /account\.max_position_amount/);
  assert.match(sql, /account\.max_daily_spend/);
  assert.match(sql, /account\.paper_budget_amount/);
  assert.match(sql, /unique\(owner_id, intent_id\)/);
});

test("paper fill commit requires a simulated intent and an unexpired matching quote", () => {
  assert.match(sql, /wolv_commit_autonomy_paper_fill/);
  assert.match(sql, /intent->>'state' = 'SIMULATED'/);
  assert.match(sql, /intent->>'quoteId' = p_quote_id/);
  assert.match(sql, /quoteExpiresAt/);
  assert.match(sql, /fill_mode text not null default 'PAPER_QUOTE'/);
});

test("ledger tables and privileged RPCs are isolated from browser roles", () => {
  assert.match(sql, /enable row level security/);
  assert.match(sql, /from anon, authenticated/);
  assert.match(sql, /to service_role/);
});
