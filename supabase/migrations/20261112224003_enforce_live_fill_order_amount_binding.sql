CREATE OR REPLACE FUNCTION public.wolv_live_execution_attempt_transition(
  p_owner_id uuid,
  p_attempt_id uuid,
  p_expected_version integer,
  p_next_status text,
  p_event_type text,
  p_actor text,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_attempt public.wolv_live_execution_attempts%ROWTYPE;
  allowed boolean := false;
  next_signer_address text;
  next_signer_operation_id text;
  next_payload_hash text;
  next_provider_order_id text;
  next_tx_hash text;
  next_amount_in text;
  next_amount_out text;
  next_fee_amount text;
  next_settlement_block text;
BEGIN
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object'
     OR p_detail::text ~* $forbidden_keys$"(signature|signatureData|typedData|typed_data|privateKey|private_key|secret|rawTransaction|raw_transaction|rawTx|calldata)"[[:space:]]*:$forbidden_keys$ THEN
    RAISE EXCEPTION 'Unsafe live execution event detail';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
     OR (p_evidence - ARRAY[
       'provider_quote_id','provider_order_id','prepared_payload_hash',
       'signer_operation_id','signer_address','transaction_hash',
       'amount_in','amount_out','fee_amount','settlement_block','last_error_code'
     ]) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Unsupported live execution evidence field';
  END IF;
  IF length(btrim(coalesce(p_event_type, ''))) < 2 OR length(btrim(coalesce(p_actor, ''))) < 2 THEN
    RAISE EXCEPTION 'Live execution event type and actor are required';
  END IF;
  IF p_next_status NOT IN (
    'PREPARED','SIGNING_REQUESTED','SIGNER_UNKNOWN','SIGNED',
    'SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PROVIDER_PENDING',
    'PROVIDER_FILLED','SETTLEMENT_PENDING','SETTLED',
    'FAILED','REJECTED','ABORTED','SECURITY_HOLD'
  ) THEN
    RAISE EXCEPTION 'Unknown live execution status';
  END IF;

  SELECT * INTO current_attempt
  FROM public.wolv_live_execution_attempts
  WHERE owner_id = p_owner_id AND id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND OR current_attempt.version <> p_expected_version THEN
    RETURN false;
  END IF;

  allowed := CASE current_attempt.status
    WHEN 'PREPARED' THEN p_next_status IN ('SIGNING_REQUESTED','ABORTED','SECURITY_HOLD')
    WHEN 'SIGNING_REQUESTED' THEN p_next_status IN ('SIGNED','SIGNER_UNKNOWN','REJECTED','SECURITY_HOLD')
    WHEN 'SIGNER_UNKNOWN' THEN p_next_status IN ('SIGNED','REJECTED','SECURITY_HOLD')
    WHEN 'SIGNED' THEN p_next_status IN ('SUBMITTING','ABORTED','SECURITY_HOLD')
    WHEN 'SUBMITTING' THEN p_next_status IN ('SUBMITTED','SUBMISSION_UNKNOWN','REJECTED','SECURITY_HOLD')
    WHEN 'SUBMISSION_UNKNOWN' THEN p_next_status IN ('SUBMITTING','SUBMITTED','PROVIDER_PENDING','PROVIDER_FILLED','FAILED','SECURITY_HOLD')
    WHEN 'SUBMITTED' THEN p_next_status IN ('PROVIDER_PENDING','PROVIDER_FILLED','FAILED','SECURITY_HOLD')
    WHEN 'PROVIDER_PENDING' THEN p_next_status IN ('PROVIDER_PENDING','PROVIDER_FILLED','FAILED','SECURITY_HOLD')
    WHEN 'PROVIDER_FILLED' THEN p_next_status IN ('SETTLEMENT_PENDING','SETTLED','SECURITY_HOLD')
    WHEN 'SETTLEMENT_PENDING' THEN p_next_status IN ('SETTLEMENT_PENDING','SETTLED','FAILED','SECURITY_HOLD')
    ELSE false
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'Invalid live execution transition: % -> %',
      current_attempt.status, p_next_status;
  END IF;

  IF current_attempt.status = 'SUBMISSION_UNKNOWN' AND p_next_status = 'SUBMITTING'
     AND (current_attempt.retry_not_after IS NULL OR current_attempt.retry_not_after <= now()) THEN
    RAISE EXCEPTION 'Provider idempotency retry window expired; do not resubmit this attempt';
  END IF;

  next_signer_address := coalesce(p_evidence->>'signer_address', current_attempt.signer_address);
  next_signer_operation_id := coalesce(p_evidence->>'signer_operation_id', current_attempt.signer_operation_id);
  next_payload_hash := coalesce(p_evidence->>'prepared_payload_hash', current_attempt.prepared_payload_hash);

  IF p_next_status IN ('SIGNING_REQUESTED','SIGNED','SUBMITTING') AND (
    next_signer_operation_id IS NULL OR length(btrim(next_signer_operation_id)) < 8 OR
    next_payload_hash IS NULL OR next_payload_hash !~ '^[0-9a-fA-F]{64}$' OR
    next_signer_address IS NULL OR next_signer_address !~* '^0x[0-9a-f]{40}$' OR
    lower(next_signer_address) <> lower(current_attempt.wallet_address)
  ) THEN
    RAISE EXCEPTION 'Signing transition requires a durable signer operation, payload hash and quote-bound wallet';
  END IF;

  next_provider_order_id := coalesce(p_evidence->>'provider_order_id', current_attempt.provider_order_id);
  next_tx_hash := coalesce(p_evidence->>'transaction_hash', current_attempt.transaction_hash);
  next_amount_in := coalesce(p_evidence->>'amount_in', current_attempt.amount_in);
  next_amount_out := coalesce(p_evidence->>'amount_out', current_attempt.amount_out);
  next_fee_amount := coalesce(p_evidence->>'fee_amount', current_attempt.fee_amount);
  next_settlement_block := coalesce(p_evidence->>'settlement_block', current_attempt.settlement_block);

  IF current_attempt.provider_order_id IS NOT NULL AND
     p_evidence ? 'provider_order_id' AND
     p_evidence->>'provider_order_id' <> current_attempt.provider_order_id THEN
    RAISE EXCEPTION 'Provider order ID cannot change after attempt creation';
  END IF;

  IF p_next_status = 'SUBMITTED' AND
     (next_provider_order_id IS NULL OR length(btrim(next_provider_order_id)) < 2) AND
     (next_tx_hash IS NULL OR next_tx_hash !~* '^0x[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Submitted state requires a provider order ID or transaction hash';
  END IF;

  IF p_next_status = 'PROVIDER_FILLED' AND (
    next_provider_order_id IS NULL OR next_provider_order_id <> current_attempt.provider_order_id OR
    next_tx_hash IS NULL OR next_tx_hash !~* '^0x[0-9a-f]{64}$' OR
    next_amount_in IS NULL OR next_amount_in !~ '^[1-9][0-9]*$' OR
    next_amount_in <> current_attempt.expected_amount_in OR
    next_amount_out IS NULL OR next_amount_out !~ '^[1-9][0-9]*$' OR
    next_amount_out::numeric < current_attempt.minimum_amount_out::numeric
  ) THEN
    RAISE EXCEPTION 'Provider fill must match the pre-bound order ID, exact input and minimum output';
  END IF;

  IF p_next_status = 'SETTLED' AND (
    next_tx_hash IS NULL OR next_tx_hash !~* '^0x[0-9a-f]{64}$' OR
    next_amount_in IS NULL OR next_amount_in !~ '^[1-9][0-9]*$' OR
    next_amount_out IS NULL OR next_amount_out !~ '^[1-9][0-9]*$' OR
    next_fee_amount IS NULL OR next_fee_amount !~ '^[1-9][0-9]*$' OR
    next_settlement_block IS NULL OR next_settlement_block !~ '^[1-9][0-9]*$' OR
    next_amount_in <> current_attempt.expected_amount_in OR
    next_amount_out::numeric < current_attempt.minimum_amount_out::numeric
  ) THEN
    RAISE EXCEPTION 'Settled state must match the pre-bound input/minimum-output and include fee/block evidence';
  END IF;

  IF p_next_status = 'SETTLED' AND current_attempt.status IN ('PROVIDER_FILLED','SETTLEMENT_PENDING') AND (
    (current_attempt.transaction_hash IS NOT NULL AND lower(next_tx_hash) <> lower(current_attempt.transaction_hash)) OR
    (current_attempt.amount_in IS NOT NULL AND next_amount_in <> current_attempt.amount_in) OR
    (current_attempt.amount_out IS NOT NULL AND next_amount_out <> current_attempt.amount_out)
  ) THEN
    RAISE EXCEPTION 'Independent settlement evidence does not match provider fill evidence';
  END IF;

  UPDATE public.wolv_live_execution_attempts
  SET status = p_next_status,
      version = version + 1,
      submission_started_at = CASE
        WHEN current_attempt.status = 'SIGNED' AND p_next_status = 'SUBMITTING'
          THEN now()
        ELSE submission_started_at
      END,
      retry_not_after = CASE
        WHEN current_attempt.status = 'SIGNED' AND p_next_status = 'SUBMITTING'
             AND current_attempt.provider_idempotency_window_seconds > 0
          THEN now() + make_interval(secs => current_attempt.provider_idempotency_window_seconds)
        ELSE retry_not_after
      END,
      provider_quote_id = CASE WHEN p_evidence ? 'provider_quote_id' THEN p_evidence->>'provider_quote_id' ELSE provider_quote_id END,
      provider_order_id = next_provider_order_id,
      prepared_payload_hash = next_payload_hash,
      signer_operation_id = next_signer_operation_id,
      signer_address = next_signer_address,
      transaction_hash = next_tx_hash,
      amount_in = next_amount_in,
      amount_out = next_amount_out,
      fee_amount = next_fee_amount,
      settlement_block = next_settlement_block,
      last_error_code = CASE WHEN p_evidence ? 'last_error_code' THEN p_evidence->>'last_error_code' ELSE last_error_code END,
      updated_at = now()
  WHERE id = p_attempt_id AND owner_id = p_owner_id;

  INSERT INTO public.wolv_live_execution_events (
    owner_id, attempt_id, intent_id, event_type, from_status, to_status, actor, detail
  ) VALUES (
    p_owner_id, p_attempt_id, current_attempt.intent_id, p_event_type,
    current_attempt.status, p_next_status, p_actor, p_detail
  );

  RETURN true;
END;
$$;