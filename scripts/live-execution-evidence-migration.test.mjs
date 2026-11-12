import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112194235_enforce_live_execution_evidence.sql", import.meta.url),
  "utf8",
);

test("live attempt inserts start only from owner-scoped risk approval", () => {
  assert.match(migration, /BEFORE INSERT ON public\.wolv_live_execution_attempts/);
  assert.match(migration, /NEW\.status <> 'PREPARED'/);
  assert.match(migration, /intent_state IS DISTINCT FROM 'RISK_APPROVED'/);
});

test("signing is wallet-bound and has a durable operation and payload fingerprint", () => {
  assert.match(migration, /next_signer_operation_id IS NULL/);
  assert.match(migration, /next_payload_hash !~ '\^\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(migration, /lower\(next_signer_address\) <> lower\(current_attempt\.wallet_address\)/);
});

test("provider fill and settlement evidence must match and be complete", () => {
  assert.match(migration, /Provider-filled state requires order, transaction and positive actual amount evidence/);
  assert.match(migration, /Settled state requires transaction, positive actual amounts, fee and block evidence/);
  assert.match(migration, /Independent settlement evidence does not match provider fill evidence/);
});
