ALTER TABLE public.wolv_autonomy_portfolios
  ADD COLUMN IF NOT EXISTS live_allowed_transaction_senders text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS live_allowed_transaction_targets text[] NOT NULL DEFAULT '{}'::text[];