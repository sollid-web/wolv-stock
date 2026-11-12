import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(
  new URL("../supabase/migrations/20261112193721_create_durable_live_execution_attempts.sql", import.meta.url),
  "utf8",
);

test("live attempts persist a stable UUIDv4 request ID and immutable attempt identity", () => {
  assert.match(sql, /request_id uuid NOT NULL UNIQUE/);
  assert.match(sql, /4\[0-9a-f\]\{3\}/);
  assert.match(sql, /UNIQUE \(owner_id, intent_id, attempt_number\)/);
  assert.match(sql, /UNIQUE \(owner_id, id\)/);
});

test("live attempts never store signatures or raw typed transaction payloads", () => {
  assert.doesNotMatch(sql, /^\s*(signature|typed_data|raw_transaction|private_key)\s+/im);
  assert.match(sql, /p_detail::text ~\*.*signature.*typedData.*privateKey.*rawTransaction/s);
  assert.match(sql, /p_evidence - ARRAY\[/);
});

test("one active attempt per intent includes security holds", () => {
  assert.match(sql, /wolv_live_execution_one_active_attempt_idx[\s\S]*WHERE status NOT IN \('SETTLED','FAILED','REJECTED','ABORTED'\)/);
});

test("unknown submission can only retry through the same persisted attempt", () => {
  assert.match(sql, /WHEN 'SUBMISSION_UNKNOWN' THEN p_next_status IN \('SUBMITTING','SUBMITTED','PROVIDER_PENDING','PROVIDER_FILLED','FAILED','SECURITY_HOLD'\)/);
  assert.match(sql, /request_id uuid NOT NULL UNIQUE/);
});

test("provider fill and settlement require evidence before terminal progression", () => {
  assert.match(sql, /Provider-filled state requires order, transaction and amount evidence/);
  assert.match(sql, /Settled state requires independent transaction, amount, fee and block evidence/);
});

test("audit events are immutable and execution tables remain server-only", () => {
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.wolv_live_execution_events/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.wolv_live_execution_attempts TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.wolv_live_execution_attempt_transition[\s\S]*TO service_role/);
});
