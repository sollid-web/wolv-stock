CREATE OR REPLACE FUNCTION public.wolv_release_unbound_live_execution_reservation(
  p_owner_id uuid,
  p_intent_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation public.wolv_live_execution_reservations%ROWTYPE;
BEGIN
  PERFORM 1
  FROM public.wolv_autonomy_portfolios
  WHERE owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO reservation
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND intent_id = p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF reservation.status = 'RELEASED' THEN RETURN true; END IF;
  IF reservation.status <> 'RESERVED' THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM public.wolv_live_execution_attempts
    WHERE owner_id = p_owner_id AND intent_id = p_intent_id
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.wolv_autonomy_portfolios
  SET live_reserved_amount = greatest(0, live_reserved_amount - reservation.amount_in),
      updated_at = now()
  WHERE owner_id = p_owner_id;

  UPDATE public.wolv_live_execution_reservations
  SET status = 'RELEASED', updated_at = now()
  WHERE owner_id = p_owner_id AND intent_id = p_intent_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.wolv_release_unbound_live_execution_reservation(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_release_unbound_live_execution_reservation(uuid,uuid)
  TO service_role;
