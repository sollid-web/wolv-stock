create table if not exists public.wolv_market_opportunities (
  chain_id integer not null check (chain_id > 0),
  token_address text not null check (token_address ~ '^0x[a-fA-F0-9]{40}$'),
  ticker text not null,
  direction text not null check (direction in ('DISCOUNT', 'PREMIUM')),
  market_price_usd numeric not null check (market_price_usd > 0),
  reference_price_usd numeric not null check (reference_price_usd > 0),
  deviation_bps integer not null,
  threshold_bps integer not null check (threshold_bps > 0),
  provider_timestamp timestamptz not null,
  status text not null check (status in ('ACTIVE', 'CLEARED')),
  observed_at timestamptz not null,
  primary key (chain_id, token_address)
);
create index if not exists wolv_market_opportunities_active
  on public.wolv_market_opportunities (status, abs(deviation_bps) desc, observed_at desc);
alter table public.wolv_market_opportunities enable row level security;
grant select on public.wolv_market_opportunities to anon, authenticated;
grant all on public.wolv_market_opportunities to service_role;
drop policy if exists "Market opportunities are publicly readable" on public.wolv_market_opportunities;
create policy "Market opportunities are publicly readable" on public.wolv_market_opportunities
  for select to anon, authenticated using (true);
