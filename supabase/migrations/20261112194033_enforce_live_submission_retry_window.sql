-- Retries after an ambiguous submit are permitted only inside the provider's declared idempotency window.
ALTER TABLE public.wolv_live_execution_attempts
  ADD COLUMN IF NOT EXISTS provider_idempotency_window_seconds integer NOT NULL DEFAULT 0
    CHECK (provider_idempotency_window_seconds BETWEEN 0 AND 86400),
  ADD COLUMN IF NOT EXISTS submission_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_not_after timestamptz;

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

  IF p_next_status = 'PROVIDER_FILLED' AND (
    coalesce(p_evidence->>'provider_order_id', current_attempt.provider_order_id) IS NULL OR
    coalesce(p_evidence->>'transaction_hash', current_attempt.transaction_hash) IS NULL OR
    coalesce(p_evidence->>'amount_in', current_attempt.amount_in) IS NULL OR
    coalesce(p_evidence->>'amount_out', current_attempt.amount_out) IS NULL
  ) THEN
    RAISE EXCEPTION 'Provider-filled state requires order, transaction and amount evidence';
  END IF;

  IF p_next_status = 'SETTLED' AND (
    coalesce(p_evidence->>'transaction_hash', current_attempt.transaction_hash) IS NULL OR
    coalesce(p_evidence->>'amount_in', current_attempt.amount_in) IS NULL OR
    coalesce(p_evidence->>'amount_out', current_attempt.amount_out) IS NULL OR
    coalesce(p_evidence->>'fee_amount', current_attempt.fee_amount) IS NULL OR
    coalesce(p_evidence->>'settlement_block', current_attempt.settlement_block) IS NULL
  ) THEN
    RAISE EXCEPTION 'Settled state requires independent transaction, amount, fee and block evidence';
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
      provider_order_id = CASE WHEN p_evidence ? 'provider_order_id' THEN p_evidence->>'provider_order_id' ELSE provider_order_id END,
      prepared_payload_hash = CASE WHEN p_evidence ? 'prepared_payload_hash' THEN p_evidence->>'prepared_payload_hash' ELSE prepared_payload_hash END,
      signer_operation_id = CASE WHEN p_evidence ? 'signer_operation_id' THEN p_evidence->>'signer_operation_id' ELSE signer_operation_id END,
      signer_address = CASE WHEN p_evidence ? 'signer_address' THEN p_evidence->>'signer_address' ELSE signer_address END,
      transaction_hash = CASE WHEN p_evidence ? 'transaction_hash' THEN p_evidence->>'transaction_hash' ELSE transaction_hash END,
      amount_in = CASE WHEN p_evidence ? 'amount_in' THEN p_evidence->>'amount_in' ELSE amount_in END,
      amount_out = CASE WHEN p_evidence ? 'amount_out' THEN p_evidence->>'amount_out' ELSE amount_out END,
      fee_amount = CASE WHEN p_evidence ? 'fee_amount' THEN p_evidence->>'fee_amount' ELSE fee_amount END,
      settlement_block = CASE WHEN p_evidence ? 'settlement_block' THEN p_evidence->>'settlement_block' ELSE settlement_block END,
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
