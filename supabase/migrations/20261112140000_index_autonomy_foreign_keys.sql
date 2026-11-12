-- Cover frequently joined/deleted intent foreign keys used by reservation and lease recovery.
CREATE INDEX IF NOT EXISTS wolv_autonomy_reservations_intent_id_idx
  ON public.wolv_autonomy_reservations (intent_id);

CREATE INDEX IF NOT EXISTS wolv_execution_leases_intent_id_idx
  ON public.wolv_execution_leases (intent_id);
