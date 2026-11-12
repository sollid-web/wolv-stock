ALTER TABLE public.wolv_live_execution_attempts
  ADD COLUMN IF NOT EXISTS settlement_allowed_senders text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS settlement_allowed_targets text[] NOT NULL DEFAULT '{}'::text[];

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
  configured_senders text[];
  configured_targets text[];
  attempt_senders text[];
  attempt_targets text[];
BEGIN
  IF NEW.status <> 'PREPARED' OR NEW.version <> 0
     OR NEW.submission_started_at IS NOT NULL OR NEW.retry_not_after IS NOT NULL
     OR NEW.execution_side <> 'BUY' OR NEW.policy_version = 'unconfigured'
     OR NEW.quote_expires_at IS NULL OR NEW.quote_expires_at <= now()
     OR NEW.provider_quote_id IS NULL OR NEW.prepared_payload_hash IS NULL
     OR NEW.token_address IS NULL OR NEW.input_token_address IS NULL
     OR NEW.expected_amount_in IS NULL OR NEW.minimum_amount_out IS NULL THEN
    RAISE EXCEPTION 'Live execution attempts must start as a fully bound, unexpired BUY in PREPARED';
  END IF;

  SELECT * INTO intent_row
  FROM public.wolv_execution_intents
  WHERE id = NEW.intent_id AND owner_id = NEW.owner_id
  FOR UPDATE;
  IF NOT FOUND OR intent_row.state IS DISTINCT FROM 'RISK_APPROVED' THEN
    RAISE EXCEPTION 'Live execution requires an owner-scoped RISK_APPROVED intent';
  END IF;

  IF lower(NEW.token_address) <> lower(intent_row.intent->>'tokenAddress') OR
     lower(NEW.input_token_address) <> lower(intent_row.intent->>'inputTokenAddress') OR
     NEW.expected_amount_in <> intent_row.intent->>'amountIn' THEN
    RAISE EXCEPTION 'Live attempt token and amount binding does not match the immutable execution intent';
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
     account.policy_version <> NEW.policy_version OR
     NOT (lower(NEW.token_address) = ANY(SELECT lower(x) FROM unnest(account.allowed_token_addresses) x)) OR
     NOT (lower(NEW.input_token_address) = ANY(SELECT lower(x) FROM unnest(account.allowed_input_token_addresses) x)) THEN
    RAISE EXCEPTION 'Live portfolio is disabled, stopped, or does not allow the attempt token/wallet';
  END IF;

  IF cardinality(NEW.settlement_allowed_senders) = 0 OR
     cardinality(NEW.settlement_allowed_targets) = 0 OR
     EXISTS (SELECT 1 FROM unnest(NEW.settlement_allowed_senders) x WHERE x !~* '^0x[0-9a-f]{40}$') OR
     EXISTS (SELECT 1 FROM unnest(NEW.settlement_allowed_targets) x WHERE x !~* '^0x[0-9a-f]{40}$') THEN
    RAISE EXCEPTION 'Live attempt requires valid, non-empty settlement sender and target allowlists';
  END IF;

  SELECT array_agg(lower(x) ORDER BY lower(x)) INTO configured_senders
  FROM unnest(account.live_allowed_transaction_senders) x;
  SELECT array_agg(lower(x) ORDER BY lower(x)) INTO configured_targets
  FROM unnest(account.live_allowed_transaction_targets) x;
  SELECT array_agg(lower(x) ORDER BY lower(x)) INTO attempt_senders
  FROM unnest(NEW.settlement_allowed_senders) x;
  SELECT array_agg(lower(x) ORDER BY lower(x)) INTO attempt_targets
  FROM unnest(NEW.settlement_allowed_targets) x;

  IF coalesce(attempt_senders, '{}'::text[]) IS DISTINCT FROM coalesce(configured_senders, '{}'::text[]) OR
     coalesce(attempt_targets, '{}'::text[]) IS DISTINCT FROM coalesce(configured_targets, '{}'::text[]) THEN
    RAISE EXCEPTION 'Attempt settlement allowlists must exactly snapshot the current live portfolio policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wolv_live_execution_reservations r
    WHERE r.owner_id = NEW.owner_id AND r.intent_id = NEW.intent_id
      AND r.status = 'RESERVED' AND r.policy_version = NEW.policy_version
      AND r.token_address = lower(NEW.token_address)
      AND r.input_token_address = lower(NEW.input_token_address)
      AND r.amount_in = NEW.expected_amount_in::numeric
  ) THEN
    RAISE EXCEPTION 'Live execution requires an exact owner/intent/token/amount budget reservation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.wolv_guard_live_execution_attempt_insert() FROM PUBLIC, anon, authenticated;
