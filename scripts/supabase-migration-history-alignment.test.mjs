import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = join(root, "supabase", "migrations");
const expected = [
  "20261112193035_create_market_price_cache.sql",
  "20261112193042_create_market_opportunities.sql",
  "20261112193048_create_autonomous_execution_queue.sql",
  "20261112193058_create_autonomy_portfolio_ledger.sql",
  "20261112193107_extend_paper_fill_exit_evidence.sql",
  "20261112193114_create_paper_exit_ledger.sql",
  "20261112193119_add_autonomy_portfolio_hard_stops.sql",
  "20261112193351_harden_autonomy_database_privileges.sql",
  "20261112193435_index_autonomy_foreign_keys.sql",
  "20261112193721_create_durable_live_execution_attempts.sql",
  "20261112193911_fix_live_execution_audit_redaction.sql",
  "20261112193943_fix_live_execution_audit_redaction_v2.sql",
  "20261112194033_enforce_live_submission_retry_window.sql",
  "20261112194235_enforce_live_execution_evidence.sql",
  "20261112194339_index_live_execution_event_owner_intent.sql",
];

test("local Supabase migration filenames exactly match the connected project's applied history", () => {
  const actual = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(actual, expected);
});
