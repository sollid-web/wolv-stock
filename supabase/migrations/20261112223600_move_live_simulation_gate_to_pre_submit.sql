CREATE OR REPLACE FUNCTION public.wolv_record_live_execution_simulation(
  p_owner_id uuid,
  p_attempt_id uuid,
  p_order_hash text,
  p_simulation_fingerprint text,
  p_simulated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt public.wolv_live_execution_attempts%ROWTYPE;
  account public.wolv_autonomy_portfolios%ROWTYPE;
  global_stop boolean;
BEGIN
  IF p_order_hash IS NULL OR p_order_hash !~* '^[0-9a-f]{64}$' OR
     p_simulation_fingerprint IS NULL OR p_simulation_fingerprint !~* '^[0-9a-f]{64}$' OR
     p_simulated_at IS NULL OR p_simulated_at > now() + interval '5 seconds' OR
     p_simulated_at < now() - interval '15 seconds' THEN
    RETURN false;
  END IF;

  SELECT * INTO attempt
  FROM public.wolv_live_execution_attempts
  WHERE owner_id = p_owner_id AND id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.status <> 'SIGNED' OR
     attempt.signer_operation_id IS NULL OR attempt.signer_address IS NULL OR
     lower(attempt.signer_address) <> lower(attempt.wallet_address) OR
     attempt.prepared_payload_hash IS NULL OR
     lower(attempt.prepared_payload_hash) <> lower(p_order_hash) OR
     attempt.quote_expires_at IS NULL OR attempt.quote_expires_at <= now() THEN
    RETURN false;
  END IF;

  SELECT kill_switch INTO global_stop
  FROM public.wolv_autonomy_global_control WHERE singleton = true;
  IF NOT FOUND OR global_stop THEN RETURN false; END IF;

  SELECT * INTO account
  FROM public.wolv_autonomy_portfolios
  WHERE owner_id = p_owner_id
  FOR SHARE;
  IF NOT FOUND OR NOT account.live_enabled OR account.live_emergency_stop OR account.emergency_stop OR
     account.wallet_address <> attempt.wallet_address OR account.policy_version <> attempt.policy_version THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wolv_live_execution_reservations r
    WHERE r.owner_id = p_owner_id AND r.intent_id = attempt.intent_id
      AND r.status = 'RESERVED' AND r.policy_version = attempt.policy_version
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.wolv_live_execution_attempts
  SET simulation_fingerprint = lower(p_simulation_fingerprint),
      simulated_at = p_simulated_at,
      updated_at = now()
  WHERE owner_id = p_owner_id AND id = p_attempt_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.wolv_guard_live_execution_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account public.wolv_autonomy_portfolios%ROWTYPE;
  global_stop boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND
     NEW.status IN ('SIGNING_REQUESTED','SIGNED','SUBMITTING') THEN
    SELECT kill_switch INTO global_stop
    FROM public.wolv_autonomy_global_control WHERE singleton = true;
    IF NOT FOUND OR global_stop THEN RAISE EXCEPTION 'Global autonomy kill switch is engaged'; END IF;

    SELECT * INTO account
    FROM public.wolv_autonomy_portfolios
    WHERE owner_id = NEW.owner_id
    FOR SHARE;
    IF NOT FOUND OR NOT account.live_enabled OR account.live_emergency_stop OR account.emergency_stop OR
       account.wallet_address <> NEW.wallet_address OR account.policy_version <> NEW.policy_version THEN
      RAISE EXCEPTION 'Live portfolio policy is disabled, stopped, or changed';
    END IF;

    IF NEW.quote_expires_at IS NULL OR NEW.quote_expires_at <= now() OR
       NEW.native_gas_preflight_at IS NULL OR NEW.native_gas_preflight_at < now() - interval '15 seconds' OR
       NEW.native_gas_balance_wei < account.live_min_native_gas_balance_wei THEN
      RAISE EXCEPTION 'Live signing requires an unexpired quote and fresh native-gas reserve preflight';
    END IF;

    IF NEW.status = 'SUBMITTING' AND (
       NEW.signer_operation_id IS NULL OR NEW.signer_address IS NULL OR
       lower(NEW.signer_address) <> lower(NEW.wallet_address) OR
       NEW.simulation_fingerprint IS NULL OR NEW.simulated_at IS NULL OR
       NEW.simulated_at < now() - interval '15 seconds'
    ) THEN
      RAISE EXCEPTION 'Submission requires a wallet-bound signature and fresh exact-order simulation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.wolv_live_execution_reservations r
      WHERE r.owner_id = NEW.owner_id AND r.intent_id = NEW.intent_id
        AND r.status = 'RESERVED' AND r.policy_version = NEW.policy_version
    ) THEN
      RAISE EXCEPTION 'Live execution reservation is missing or released';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.wolv_record_live_execution_simulation(uuid,uuid,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_record_live_execution_simulation(uuid,uuid,text,text,timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.wolv_guard_live_execution_attempt_update() FROM PUBLIC, anon, authenticated;
