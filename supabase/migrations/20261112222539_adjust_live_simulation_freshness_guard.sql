CREATE OR REPLACE FUNCTION public.wolv_guard_live_execution_attempt_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

    IF NEW.status = 'SIGNING_REQUESTED' AND (
       NEW.simulation_fingerprint IS NULL OR NEW.simulated_at IS NULL OR
       NEW.simulated_at < now() - interval '15 seconds'
    ) THEN
      RAISE EXCEPTION 'Initial signing requires a fresh exact-order simulation';
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
$function$
