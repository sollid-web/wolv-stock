import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112170000_enforce_live_submission_retry_window.sql", import.meta.url),
  "utf8",
);

test("unknown submissions can only retry inside the persisted provider idempotency window", () => {
  assert.match(migration, /provider_idempotency_window_seconds integer NOT NULL DEFAULT 0/);
  assert.match(migration, /retry_not_after timestamptz/);
  assert.match(migration, /current_attempt\.retry_not_after IS NULL OR current_attempt\.retry_not_after <= now\(\)/);
  assert.match(migration, /Provider idempotency retry window expired/);
  assert.match(migration, /request_id/);
  assert.doesNotMatch(migration, /SET\s+request_id\s*=/i);
});
