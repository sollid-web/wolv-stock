import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112190000_index_live_execution_event_owner_intent.sql", import.meta.url),
  "utf8",
);

test("live execution event owner/intent foreign key is indexed", () => {
  assert.match(migration, /wolv_live_execution_events_owner_intent_idx/);
  assert.match(migration, /\(owner_id, intent_id\)/);
});
