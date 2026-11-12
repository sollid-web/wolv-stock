import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112224003_enforce_live_fill_order_amount_binding.sql", import.meta.url),
  "utf8",
);

test("provider fill is bound to the pre-persisted provider order ID", () => {
  assert.match(migration, /Provider order ID cannot change after attempt creation/);
  assert.match(migration, /next_provider_order_id <> current_attempt\.provider_order_id/);
});

test("provider fill must match exact input and minimum output from the reserved intent", () => {
  assert.match(migration, /next_amount_in <> current_attempt\.expected_amount_in/);
  assert.match(migration, /next_amount_out::numeric < current_attempt\.minimum_amount_out::numeric/);
  assert.match(migration, /Provider fill must match the pre-bound order ID, exact input and minimum output/);
});

test("settlement must preserve the independently verified provider fill amounts", () => {
  assert.match(migration, /Independent settlement evidence does not match provider fill evidence/);
  assert.match(migration, /Settled state must match the pre-bound input\/minimum-output/);
});
