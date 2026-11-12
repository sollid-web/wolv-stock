CREATE INDEX IF NOT EXISTS wolv_live_execution_fills_owner_intent_idx
  ON public.wolv_live_execution_fills (owner_id, intent_id);
