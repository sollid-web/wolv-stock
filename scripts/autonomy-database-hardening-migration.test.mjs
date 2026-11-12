import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(
  new URL("../supabase/migrations/20261112130000_harden_autonomy_database_privileges.sql", import.meta.url),
  "utf8",
);

test("hardens every WOLV security-definer function search path", () => {
  assert.match(sql, /p\.prosecdef/);
  assert.match(sql, /ALTER FUNCTION %s SET search_path = pg_catalog, public/);
  assert.match(sql, /ALTER FUNCTION public\.wolv_keep_newest_market_price\(\)\s+SET search_path = pg_catalog, public/);
});

test("keeps market data publicly readable but removes public write privileges", () => {
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*wolv_market_prices_latest[\s\S]*wolv_market_price_history[\s\S]*wolv_market_opportunities[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT ON TABLE[\s\S]*TO anon, authenticated/);
});

test("removes direct execution access to the market-price trigger function", () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.wolv_keep_newest_market_price\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
});
