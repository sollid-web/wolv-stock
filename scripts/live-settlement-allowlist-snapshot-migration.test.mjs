import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112224135_snapshot_live_settlement_allowlists.sql", import.meta.url),
  "utf8",
);

test("snapshots vendor settlement sender and target allowlists on each live attempt", () => {
  assert.match(migration, /settlement_allowed_senders text\[\] NOT NULL DEFAULT/);
  assert.match(migration, /settlement_allowed_targets text\[\] NOT NULL DEFAULT/);
  assert.match(migration, /Attempt settlement allowlists must exactly snapshot the current live portfolio policy/);
  assert.match(migration, /NEW\.settlement_allowed_senders/);
  assert.match(migration, /NEW\.settlement_allowed_targets/);
});
