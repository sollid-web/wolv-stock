import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112225110_allow_reuse_of_released_live_reservations.sql", import.meta.url),
  "utf8",
);

test("released live reservations can be reused only after prior attempts are terminal", () => {
  assert.match(migration, /existing\.status = 'RELEASED'/);
  assert.match(migration, /status NOT IN \('SETTLED','FAILED','REJECTED','ABORTED'\)/);
  assert.match(migration, /status = 'RESERVED'/);
});

test("re-reservation reuses the existing owner/intent row and restores reserved budget", () => {
  assert.match(migration, /UPDATE public\.wolv_live_execution_reservations/);
  assert.match(migration, /SET[\s\S]*status = 'RESERVED'[\s\S]*created_at = now\(\)/);
  assert.match(migration, /live_reserved_amount = live_reserved_amount \+ p_amount_in/);
  assert.match(migration, /INSERT INTO public\.wolv_live_execution_reservations/);
});
