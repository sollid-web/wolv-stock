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

  SELECT * INTO existing
  FROM public.wolv_live_execution_reservations
  WHERE owner_id = p_owner_id AND intent_id = p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.status = 'RESERVED' THEN
      RETURN existing.amount_in = p_amount_in
        AND existing.token_address = lower(p_token_address)
        AND existing.input_token_address = lower(p_input_token_address)
        AND existing.policy_version = p_policy_version;
    END IF;
    IF existing.status <> 'RELEASED' THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM public.wolv_live_execution_attempts
      WHERE owner_id = p_owner_id AND intent_id = p_intent_id
        AND status NOT IN ('SETTLED','FAILED','REJECTED','ABORTED')
    ) THEN
      RETURN false;
    END IF;
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

  IF existing.id IS NULL THEN
    INSERT INTO public.wolv_live_execution_reservations (
      owner_id, intent_id, chain_id, token_address, input_token_address,
      amount_in, policy_version, status
    ) VALUES (
      p_owner_id, p_intent_id, p_chain_id, lower(p_token_address), lower(p_input_token_address),
      p_amount_in, p_policy_version, 'RESERVED'
    );
  ELSE
    UPDATE public.wolv_live_execution_reservations
    SET chain_id = p_chain_id,
        token_address = lower(p_token_address),
        input_token_address = lower(p_input_token_address),
        amount_in = p_amount_in,
        policy_version = p_policy_version,
        status = 'RESERVED',
        created_at = now(),
        updated_at = now()
    WHERE id = existing.id AND owner_id = p_owner_id;
  END IF;

  UPDATE public.wolv_autonomy_portfolios
  SET live_reserved_amount = live_reserved_amount + p_amount_in,
      updated_at = now()
  WHERE owner_id = p_owner_id;

  RETURN true;
END;
$$;