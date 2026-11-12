-- Cover the owner-scoped intent foreign key used by the immutable live event ledger.
CREATE INDEX IF NOT EXISTS wolv_live_execution_events_owner_intent_idx
  ON public.wolv_live_execution_events (owner_id, intent_id);
