import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20261112160000_fix_live_execution_audit_redaction.sql", import.meta.url),
  "utf8",
);

test("database audit redaction detects sensitive keys recursively and literally", () => {
  assert.match(migration, /p_detail::text ~\* \$forbidden_keys\$/);
  for (const key of ["signatureData", "typedData", "typed_data", "privateKey", "private_key", "rawTransaction", "raw_transaction", "rawTx", "calldata"]) {
    assert.ok(migration.includes(key), `missing forbidden audit key: ${key}`);
  }
  assert.match(migration, /\[\[:space:\]\]\*:/);
});
