create table if not exists public.tokenized_market_pulse (
  ticker text primary key check (ticker in ('SPY', 'QQQ', 'NVDA', 'ORCL')),
  price numeric,
  indicative_estimate numeric,
  reference_price numeric,
  reference_gap numeric,
  quote_freshness_seconds integer,
  market_status text not null,
  session_mismatch boolean not null default false,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.tokenized_market_pulse enable row level security;

grant select on public.tokenized_market_pulse to anon, authenticated;
grant all on public.tokenized_market_pulse to service_role;

create policy "Market pulse is readable by everyone"
  on public.tokenized_market_pulse
  for select
  to anon, authenticated
  using (true);
