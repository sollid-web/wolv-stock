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
  "20261112221718_add_live_execution_policy_and_ledger.sql",
  "20261112221811_correct_live_execution_budget_enforcement.sql",
  "20261112222211_require_live_order_simulation_proof.sql",
  "20261112222512_add_unbound_live_reservation_release.sql",
  "20261112222539_adjust_live_simulation_freshness_guard.sql",
  "20261112223108_add_live_settlement_contract_allowlists.sql",
  "20261112223218_bind_live_attempt_tokens_and_amounts.sql",
  "20261112223453_index_live_execution_fill_owner_intent.sql",
  "20261112223600_move_live_simulation_gate_to_pre_submit.sql",
  "20261112223453_index_live_execution_fill_owner_intent.sql",
];

test("local Supabase migration filenames exactly match the connected project's applied history", () => {
  const actual = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(actual, expected);
});
