import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112100000_add_autonomy_portfolio_hard_stops.sql", import.meta.url),
  "utf8",
);

test("portfolio hard-stop migration adds bounded concurrent-position and daily-loss policy", () => {
  assert.match(migration, /max_open_positions integer not null default 1/);
  assert.match(migration, /max_open_positions between 1 and 100/);
  assert.match(migration, /max_daily_realized_loss numeric\(78,0\) not null default 1/);
  assert.match(migration, /max_daily_realized_loss > 0/);
});

test("atomic budget reservation checks open positions and realized losses", () => {
  assert.match(migration, /wolv_autonomy_positions[\s\S]*?amount_units > 0[\s\S]*?union[\s\S]*?wolv_autonomy_reservations/);
  assert.match(migration, /open_position_count >= account\.max_open_positions/);
  assert.match(migration, /wolv_autonomy_paper_exits[\s\S]*?realized_pnl_input_units < 0/);
  assert.match(migration, /daily_realized_loss >= account\.max_daily_realized_loss/);
});

test("reservation accepts both legacy and normalized quote audit event names", () => {
  assert.match(migration, /BINANCE_ROUNDTRIP_QUOTES_VALIDATED','PROVIDER_ROUNDTRIP_QUOTES_VALIDATED/);
});

test("reservation remains serialized and fail-closed", () => {
  assert.match(migration, /where owner_id = p_owner_id\s+for update/);
  assert.match(migration, /not account\.enabled or account\.emergency_stop/);
  assert.match(migration, /account\.policy_version <> p_policy_version/);
});


test("aggregate risk snapshot is database-computed and preserves exact loss values", () => {
  assert.match(migration, /wolv_get_autonomy_risk_snapshot/);
  assert.match(migration, /daily_realized_loss text/);
  assert.match(migration, /realized_losses\.loss::text/);
  assert.match(migration, /revoke all on function public\.wolv_get_autonomy_risk_snapshot/);
  assert.match(migration, /grant execute on function public\.wolv_get_autonomy_risk_snapshot\(uuid\) to service_role/);
});
