-- Durable live-order lifecycle. No signing secret, signature, raw typed data or raw tx is stored.
CREATE UNIQUE INDEX IF NOT EXISTS wolv_execution_intents_owner_id_id_idx
  ON public.wolv_execution_intents (owner_id, id);

CREATE TABLE IF NOT EXISTS public.wolv_live_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_id uuid NOT NULL UNIQUE
    CHECK (request_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 2 AND 64),
  chain_id text NOT NULL CHECK (chain_id = '56'),
  wallet_address text NOT NULL CHECK (wallet_address ~* '^0x[0-9a-f]{40}$'),
  status text NOT NULL DEFAULT 'PREPARED'
    CHECK (status IN (
      'PREPARED','SIGNING_REQUESTED','SIGNER_UNKNOWN','SIGNED',
      'SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PROVIDER_PENDING',
      'PROVIDER_FILLED','SETTLEMENT_PENDING','SETTLED',
      'FAILED','REJECTED','ABORTED','SECURITY_HOLD'
    )),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  provider_quote_id text,
  provider_order_id text,
  prepared_payload_hash text CHECK (prepared_payload_hash IS NULL OR prepared_payload_hash ~* '^[0-9a-f]{64}$'),
  signer_operation_id text,
  signer_address text CHECK (signer_address IS NULL OR signer_address ~* '^0x[0-9a-f]{40}$'),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~* '^0x[0-9a-f]{64}$'),
  amount_in text CHECK (amount_in IS NULL OR amount_in ~ '^[1-9][0-9]*$'),
  amount_out text CHECK (amount_out IS NULL OR amount_out ~ '^[1-9][0-9]*$'),
  fee_amount text CHECK (fee_amount IS NULL OR fee_amount ~ '^[0-9]+$'),
  settlement_block text CHECK (settlement_block IS NULL OR settlement_block ~ '^[1-9][0-9]*$'),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, intent_id, attempt_number),
  FOREIGN KEY (owner_id, intent_id)
    REFERENCES public.wolv_execution_intents (owner_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS wolv_live_execution_one_active_attempt_idx
  ON public.wolv_live_execution_attempts (owner_id, intent_id)
  WHERE status NOT IN ('SETTLED','FAILED','REJECTED','ABORTED');

CREATE INDEX IF NOT EXISTS wolv_live_execution_recovery_idx
  ON public.wolv_live_execution_attempts (owner_id, updated_at)
  WHERE status NOT IN ('SETTLED','FAILED','REJECTED','ABORTED','SECURITY_HOLD');

CREATE TABLE IF NOT EXISTS public.wolv_live_execution_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 2 AND 96),
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 2 AND 64),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  FOREIGN KEY (owner_id, attempt_id)
    REFERENCES public.wolv_live_execution_attempts (owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, intent_id)
    REFERENCES public.wolv_execution_intents (owner_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS wolv_live_execution_events_attempt_idx
  ON public.wolv_live_execution_events (owner_id, attempt_id, occurred_at);

CREATE OR REPLACE FUNCTION public.wolv_live_execution_initial_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.wolv_live_execution_events (
    owner_id, attempt_id, intent_id, event_type, from_status, to_status, actor, detail
  ) VALUES (
    NEW.owner_id, NEW.id, NEW.intent_id, 'LIVE_ATTEMPT_CREATED',
    NULL, NEW.status, 'SYSTEM', jsonb_build_object(
      'provider', NEW.provider, 'chain_id', NEW.chain_id, 'attempt_number', NEW.attempt_number
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.wolv_live_execution_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'WOLV live execution audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS wolv_live_execution_initial_event_trigger
  ON public.wolv_live_execution_attempts;
CREATE TRIGGER wolv_live_execution_initial_event_trigger
AFTER INSERT ON public.wolv_live_execution_attempts
FOR EACH ROW EXECUTE FUNCTION public.wolv_live_execution_initial_event();

DROP TRIGGER IF EXISTS wolv_live_execution_event_immutable_trigger
  ON public.wolv_live_execution_events;
CREATE TRIGGER wolv_live_execution_event_immutable_trigger
BEFORE UPDATE OR DELETE ON public.wolv_live_execution_events
FOR EACH ROW EXECUTE FUNCTION public.wolv_live_execution_event_immutable();

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
     OR p_detail::text ~* '"(signature|typedData|privateKey|secret|rawTransaction)"[[:space:]]*:' THEN
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

ALTER TABLE public.wolv_live_execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wolv_live_execution_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.wolv_live_execution_attempts,
  public.wolv_live_execution_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.wolv_live_execution_attempts TO service_role;
GRANT SELECT, INSERT ON TABLE public.wolv_live_execution_events TO service_role;

REVOKE ALL ON FUNCTION public.wolv_live_execution_initial_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wolv_live_execution_event_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wolv_live_execution_attempt_transition(uuid, uuid, integer, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wolv_live_execution_attempt_transition(uuid, uuid, integer, text, text, text, jsonb, jsonb)
  TO service_role;
