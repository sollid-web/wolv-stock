CREATE OR REPLACE FUNCTION public.wolv_reserve_live_execution_budget(
  p_owner_id uuid,
  p_intent_id uuid,
  p_wallet_address text,
  p_chain_id text,
  p_token_address text,
  p_input_token_address text,
  p_amount_in numeric,
  p_policy_version text,
  p_quote_observed_at timestamptz,
  p_quote_expires_at timestamptz,
  p_slippage_bps integer,
  p_price_impact_bps integer,
  p_gas_cost_usd numeric,
  p_expected_edge_bps integer,
  p_native_gas_balance_wei numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account public.wolv_autonomy_portfolios%ROWTYPE;
  existing public.wolv_live_execution_reservations%ROWTYPE;
  global_stop boolean;
  utc_today date := (now() AT TIME ZONE 'utc')::date;
  utc_midnight timestamptz := ((now() AT TIME ZONE 'utc')::date::timestamp AT TIME ZONE 'utc');
  current_position numeric(78,0) := 0;
  reserved_position numeric(78,0) := 0;
  open_positions integer := 0;
  open_orders integer := 0;
  daily_reservations numeric(78,0) := 0;
  daily_realized_loss numeric(78,0) := 0;
BEGIN
  IF p_amount_in IS NULL OR p_amount_in <= 0 OR p_amount_in <> trunc(p_amount_in) OR
     p_gas_cost_usd IS NULL OR p_gas_cost_usd < 0 OR
     p_native_gas_balance_wei IS NULL OR p_native_gas_balance_wei < 0 OR p_native_gas_balance_wei <> trunc(p_native_gas_balance_wei) OR
     p_slippage_bps IS NULL OR p_price_impact_bps IS NULL OR p_expected_edge_bps IS NULL OR
     p_quote_observed_at IS NULL OR p_quote_expires_at IS NULL OR p_quote_expires_at <= now() OR
     p_quote_expires_at <= p_quote_observed_at OR p_quote_observed_at > now() + interval '5 seconds' OR
     p_wallet_address IS NULL OR p_wallet_address !~* '^0x[0-9a-f]{40}$' OR
     p_token_address IS NULL OR p_token_address !~* '^0x[0-9a-f]{40}$' OR
     p_input_token_address IS NULL OR p_input_token_address !~* '^0x[0-9a-f]{40}$' THEN
    RETURN false;
  END IF;

  SELECT kill_switch INTO global_stop
  FROM public.wolv_autonomy_global_control
  WHERE singleton = true;
  IF NOT FOUND OR global_stop THEN RETURN false; END IF;

  SELECT * INTO account
  FROM public.wolv_autonomy_portfolios
  WHERE owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND OR NOT account.live_enabled OR account.live_emergency_stop OR account.emergency_stop THEN
    RETURN false;
  END IF;

  IF account.wallet_address <> lower(p_wallet_address) OR
     p_chain_id <> '56' OR account.chain_id <> p_chain_id OR
     p_policy_version IS NULL OR account.policy_version <> p_policy_version OR
     NOT (p_chain_id = ANY(account.allowed_chain_ids)) OR
     NOT (lower(p_token_address) = ANY(SELECT lower(x) FROM unnest(account.allowed_token_addresses) x)) OR
     NOT (lower(p_input_token_address) = ANY(SELECT lower(x) FROM unnest(account.allowed_input_token_addresses) x)) THEN
    RETURN false;
  END IF;

  SELECT * INTO existing
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND intent_id = p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    RETURN existing.status = 'RESERVED'
      AND existing.amount_in = p_amount_in
      AND existing.token_address = lower(p_token_address)
      AND existing.input_token_address = lower(p_input_token_address)
      AND existing.policy_version = p_policy_version;
  END IF;

  IF account.live_budget_amount <= 0 OR account.live_max_order_amount <= 0 OR
     account.live_max_position_amount <= 0 OR account.live_max_daily_spend <= 0 OR
     account.live_max_daily_realized_loss <= 0 OR account.live_max_quote_age_ms <= 0 OR
     account.live_max_gas_cost_usd <= 0 THEN
    RETURN false;
  END IF;

  IF now() - p_quote_observed_at > make_interval(secs => account.live_max_quote_age_ms::double precision / 1000.0) OR
     p_amount_in > account.live_max_order_amount OR
     p_slippage_bps < 0 OR p_slippage_bps > account.live_max_slippage_bps OR
     p_price_impact_bps < 0 OR p_price_impact_bps > account.live_max_price_impact_bps OR
     p_gas_cost_usd > account.live_max_gas_cost_usd OR
     p_expected_edge_bps < account.live_min_expected_edge_bps OR
     p_native_gas_balance_wei < account.live_min_native_gas_balance_wei THEN
    RETURN false;
  END IF;

  IF account.live_daily_spend_date <> utc_today THEN
    UPDATE public.wolv_autonomy_portfolios
    SET live_daily_spend_amount = 0, live_daily_spend_date = utc_today
    WHERE owner_id = p_owner_id;
    account.live_daily_spend_amount := 0;
    account.live_daily_spend_date := utc_today;
  END IF;

  SELECT coalesce(cost_basis_input_units, 0) INTO current_position
  FROM public.wolv_live_execution_positions
  WHERE owner_id = p_owner_id AND chain_id = p_chain_id AND token_address = lower(p_token_address);
  current_position := coalesce(current_position, 0);

  SELECT coalesce(sum(amount_in), 0) INTO reserved_position
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND chain_id = p_chain_id
    AND token_address = lower(p_token_address) AND status = 'RESERVED';

  IF current_position + reserved_position + p_amount_in > account.live_max_position_amount THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO open_orders
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND status = 'RESERVED';
  IF open_orders >= account.live_max_open_orders THEN RETURN false; END IF;

  SELECT count(*) INTO open_positions
  FROM (
    SELECT token_address FROM public.wolv_live_execution_positions
    WHERE owner_id = p_owner_id AND chain_id = p_chain_id AND amount_units > 0
    UNION
    SELECT token_address FROM public.wolv_live_execution_reservations
    WHERE owner_id = p_owner_id AND chain_id = p_chain_id AND status = 'RESERVED'
  ) active_tokens;
  IF current_position = 0 AND reserved_position = 0 AND open_positions >= account.live_max_open_positions THEN
    RETURN false;
  END IF;

  SELECT coalesce(sum(amount_in), 0) INTO daily_reservations
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND status = 'RESERVED' AND created_at >= utc_midnight;

  SELECT coalesce(sum(-realized_pnl_input_units), 0) INTO daily_realized_loss
  FROM public.wolv_live_execution_exits
  WHERE owner_id = p_owner_id AND realized_pnl_input_units < 0 AND created_at >= utc_midnight;

  IF daily_realized_loss >= account.live_max_daily_realized_loss OR
     account.live_daily_spend_amount + daily_reservations + p_amount_in > account.live_max_daily_spend OR
     account.live_reserved_amount + account.live_committed_amount + p_amount_in > account.live_budget_amount THEN
    RETURN false;
  END IF;

  INSERT INTO public.wolv_live_execution_reservations (
    owner_id, intent_id, chain_id, token_address, input_token_address,
    amount_in, policy_version, status
  ) VALUES (
    p_owner_id, p_intent_id, p_chain_id, lower(p_token_address), lower(p_input_token_address),
    p_amount_in, p_policy_version, 'RESERVED'
  );

  UPDATE public.wolv_autonomy_portfolios
  SET live_reserved_amount = live_reserved_amount + p_amount_in,
      updated_at = now()
  WHERE owner_id = p_owner_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.wolv_guard_live_execution_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  intent_row public.wolv_execution_intents%ROWTYPE;
  account public.wolv_autonomy_portfolios%ROWTYPE;
  global_stop boolean;
BEGIN
  IF NEW.status <> 'PREPARED' OR NEW.version <> 0
     OR NEW.submission_started_at IS NOT NULL OR NEW.retry_not_after IS NOT NULL
     OR NEW.execution_side <> 'BUY' OR NEW.policy_version = 'unconfigured'
     OR NEW.quote_expires_at IS NULL OR NEW.quote_expires_at <= now() THEN
    RAISE EXCEPTION 'Live execution attempts must start as an unexpired, policy-bound BUY in PREPARED';
  END IF;

  SELECT * INTO intent_row
  FROM public.wolv_execution_intents
  WHERE id = NEW.intent_id AND owner_id = NEW.owner_id
  FOR UPDATE;
  IF NOT FOUND OR intent_row.state IS DISTINCT FROM 'RISK_APPROVED' THEN
    RAISE EXCEPTION 'Live execution requires an owner-scoped RISK_APPROVED intent';
  END IF;

  SELECT kill_switch INTO global_stop
  FROM public.wolv_autonomy_global_control WHERE singleton = true;
  IF NOT FOUND OR global_stop THEN RAISE EXCEPTION 'Global autonomy kill switch is engaged'; END IF;

  SELECT * INTO account
  FROM public.wolv_autonomy_portfolios
  WHERE owner_id = NEW.owner_id
  FOR SHARE;
  IF NOT FOUND OR NOT account.live_enabled OR account.live_emergency_stop OR account.emergency_stop OR
     account.wallet_address <> NEW.wallet_address OR account.chain_id <> NEW.chain_id OR
     account.policy_version <> NEW.policy_version THEN
    RAISE EXCEPTION 'Live portfolio is disabled, stopped, or does not match the attempt';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wolv_live_execution_reservations r
    WHERE r.owner_id = NEW.owner_id AND r.intent_id = NEW.intent_id
      AND r.status = 'RESERVED' AND r.policy_version = NEW.policy_version
      AND r.token_address = lower(intent_row.intent->>'tokenAddress')
      AND r.input_token_address = lower(intent_row.intent->>'inputTokenAddress')
      AND r.amount_in = (intent_row.intent->>'amountIn')::numeric
  ) THEN
    RAISE EXCEPTION 'Live execution requires an exact owner/intent/token/amount budget reservation';
  END IF;
  RETURN NEW;
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
      RAISE EXCEPTION 'Live signing requires a fresh quote and fresh native-gas reserve preflight';
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

CREATE OR REPLACE FUNCTION public.wolv_commit_live_execution_fill(
  p_owner_id uuid,
  p_attempt_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt public.wolv_live_execution_attempts%ROWTYPE;
  reservation public.wolv_live_execution_reservations%ROWTYPE;
  intent_payload jsonb;
  token_address text;
  input_token_address text;
  utc_today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  SELECT * INTO attempt
  FROM public.wolv_live_execution_attempts
  WHERE owner_id = p_owner_id AND id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.status <> 'SETTLED' OR attempt.execution_side <> 'BUY' THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.wolv_live_execution_fills f WHERE f.owner_id = p_owner_id AND f.attempt_id = p_attempt_id) THEN
    RETURN true;
  END IF;

  SELECT * INTO reservation
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND intent_id = attempt.intent_id
  FOR UPDATE;
  IF NOT FOUND OR reservation.status <> 'RESERVED' OR reservation.policy_version <> attempt.policy_version THEN
    RETURN false;
  END IF;

  SELECT intent INTO intent_payload
  FROM public.wolv_execution_intents
  WHERE owner_id = p_owner_id AND id = attempt.intent_id;
  IF intent_payload IS NULL THEN RETURN false; END IF;

  token_address := lower(intent_payload->>'tokenAddress');
  input_token_address := lower(intent_payload->>'inputTokenAddress');
  IF token_address IS NULL OR input_token_address IS NULL OR
     token_address <> reservation.token_address OR input_token_address <> reservation.input_token_address OR
     attempt.amount_in IS NULL OR attempt.amount_out IS NULL OR attempt.fee_amount IS NULL OR
     attempt.settlement_block IS NULL OR attempt.transaction_hash IS NULL OR
     attempt.provider_order_id IS NULL OR length(btrim(attempt.provider_order_id)) < 2 OR
     attempt.amount_in::numeric <> reservation.amount_in OR attempt.amount_out::numeric <= 0 THEN
    RAISE EXCEPTION 'Settled live attempt evidence does not match its reservation and intent';
  END IF;

  INSERT INTO public.wolv_live_execution_fills (
    owner_id, intent_id, attempt_id, chain_id, token_address, input_token_address,
    provider_order_id, transaction_hash, amount_in, amount_out, fee_wei, settlement_block
  ) VALUES (
    p_owner_id, attempt.intent_id, attempt.id, attempt.chain_id, token_address, input_token_address,
    attempt.provider_order_id, attempt.transaction_hash,
    attempt.amount_in::numeric, attempt.amount_out::numeric, attempt.fee_amount::numeric,
    attempt.settlement_block::numeric
  );

  INSERT INTO public.wolv_live_execution_positions (
    owner_id, chain_id, token_address, amount_units, cost_basis_input_units
  ) VALUES (
    p_owner_id, attempt.chain_id, token_address, attempt.amount_out::numeric, attempt.amount_in::numeric
  )
  ON CONFLICT (owner_id, chain_id, token_address) DO UPDATE
  SET amount_units = public.wolv_live_execution_positions.amount_units + EXCLUDED.amount_units,
      cost_basis_input_units = public.wolv_live_execution_positions.cost_basis_input_units + EXCLUDED.cost_basis_input_units,
      updated_at = now();

  UPDATE public.wolv_autonomy_portfolios
  SET live_reserved_amount = greatest(0, live_reserved_amount - reservation.amount_in),
      live_committed_amount = live_committed_amount + reservation.amount_in,
      live_daily_spend_amount = CASE
        WHEN live_daily_spend_date = utc_today THEN live_daily_spend_amount + reservation.amount_in
        ELSE reservation.amount_in
      END,
      live_daily_spend_date = utc_today,
      updated_at = now()
  WHERE owner_id = p_owner_id;

  UPDATE public.wolv_live_execution_reservations
  SET status = 'COMMITTED', updated_at = now()
  WHERE owner_id = p_owner_id AND intent_id = attempt.intent_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.wolv_release_live_execution_budget(
  p_owner_id uuid,
  p_attempt_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt public.wolv_live_execution_attempts%ROWTYPE;
  reservation public.wolv_live_execution_reservations%ROWTYPE;
BEGIN
  SELECT * INTO attempt
  FROM public.wolv_live_execution_attempts
  WHERE owner_id = p_owner_id AND id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.status NOT IN ('PREPARED','SIGNING_REQUESTED','SIGNER_UNKNOWN','SIGNED','REJECTED','FAILED','ABORTED') THEN
    RETURN false;
  END IF;

  SELECT * INTO reservation
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND intent_id = attempt.intent_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF reservation.status = 'RELEASED' THEN RETURN true; END IF;
  IF reservation.status <> 'RESERVED' THEN RETURN false; END IF;

  UPDATE public.wolv_autonomy_portfolios
  SET live_reserved_amount = greatest(0, live_reserved_amount - reservation.amount_in),
      updated_at = now()
  WHERE owner_id = p_owner_id;

  UPDATE public.wolv_live_execution_reservations
  SET status = 'RELEASED', updated_at = now()
  WHERE owner_id = p_owner_id AND intent_id = attempt.intent_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.wolv_record_live_execution_gas_preflight(
  p_owner_id uuid,
  p_attempt_id uuid,
  p_native_balance_wei numeric
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
  IF p_native_balance_wei IS NULL OR p_native_balance_wei < 0 OR p_native_balance_wei <> trunc(p_native_balance_wei) THEN
    RETURN false;
  END IF;

  SELECT * INTO attempt
  FROM public.wolv_live_execution_attempts
  WHERE owner_id = p_owner_id AND id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.status NOT IN ('PREPARED','SIGNING_REQUESTED','SIGNER_UNKNOWN','SIGNED','SUBMISSION_UNKNOWN') THEN
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
     account.wallet_address <> attempt.wallet_address OR account.policy_version <> attempt.policy_version OR
     account.live_min_native_gas_balance_wei > p_native_balance_wei OR
     attempt.quote_expires_at IS NULL OR attempt.quote_expires_at <= now() THEN
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
  SET native_gas_balance_wei = p_native_balance_wei,
      native_gas_preflight_at = now(),
      updated_at = now()
  WHERE owner_id = p_owner_id AND id = p_attempt_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.wolv_reserve_live_execution_budget(uuid,uuid,text,text,text,text,numeric,text,timestamptz,timestamptz,integer,integer,numeric,integer,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_reserve_live_execution_budget(uuid,uuid,text,text,text,text,numeric,text,timestamptz,timestamptz,integer,integer,numeric,integer,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.wolv_record_live_execution_gas_preflight(uuid,uuid,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_record_live_execution_gas_preflight(uuid,uuid,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.wolv_commit_live_execution_fill(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_commit_live_execution_fill(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.wolv_release_live_execution_budget(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_release_live_execution_budget(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.wolv_guard_live_execution_attempt_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wolv_guard_live_execution_attempt_update() FROM PUBLIC, anon, authenticated;
