import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(
  new URL("../supabase/migrations/20261112193435_index_autonomy_foreign_keys.sql", import.meta.url),
  "utf8",
);

test("indexes both intent foreign keys used by autonomy reservations and leases", () => {
  assert.match(sql, /wolv_autonomy_reservations_intent_id_idx[\s\S]*ON public\.wolv_autonomy_reservations \(intent_id\)/);
  assert.match(sql, /wolv_execution_leases_intent_id_idx[\s\S]*ON public\.wolv_execution_leases \(intent_id\)/);
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 2);
});
