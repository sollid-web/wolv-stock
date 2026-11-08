create table if not exists public.wolv_market_prices_latest (
  chain_id integer not null check (chain_id > 0),
  token_address text not null check (token_address ~ '^0x[a-fA-F0-9]{40}$'),
  ticker text not null,
  price_usd numeric not null check (price_usd > 0),
  reference_price_usd numeric check (reference_price_usd is null or reference_price_usd > 0),
  provider text not null,
  provider_timestamp timestamptz not null,
  observed_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  primary key (chain_id, token_address)
);
create index if not exists wolv_market_prices_latest_ticker on public.wolv_market_prices_latest (ticker);
create index if not exists wolv_market_prices_latest_observed on public.wolv_market_prices_latest (observed_at desc);

create table if not exists public.wolv_market_price_history (
  observation_id bigint generated always as identity primary key,
  chain_id integer not null check (chain_id > 0),
  token_address text not null check (token_address ~ '^0x[a-fA-F0-9]{40}$'),
  ticker text not null,
  price_usd numeric not null check (price_usd > 0),
  reference_price_usd numeric check (reference_price_usd is null or reference_price_usd > 0),
  provider text not null,
  provider_timestamp timestamptz not null,
  ingested_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  unique (chain_id, token_address, provider, provider_timestamp)
);
create index if not exists wolv_market_price_history_asset_time
  on public.wolv_market_price_history (chain_id, lower(token_address), provider_timestamp desc);

alter table public.wolv_market_prices_latest enable row level security;
alter table public.wolv_market_price_history enable row level security;
grant select on public.wolv_market_prices_latest to anon, authenticated;
grant select on public.wolv_market_price_history to anon, authenticated;
grant all on public.wolv_market_prices_latest to service_role;
grant all on public.wolv_market_price_history to service_role;
drop policy if exists "Market prices are publicly readable" on public.wolv_market_prices_latest;
create policy "Market prices are publicly readable" on public.wolv_market_prices_latest
  for select to anon, authenticated using (true);
drop policy if exists "Market price history is publicly readable" on public.wolv_market_price_history;
create policy "Market price history is publicly readable" on public.wolv_market_price_history
  for select to anon, authenticated using (true);

-- Never let a delayed provider response replace a newer cached price.
create or replace function public.wolv_keep_newest_market_price()
returns trigger language plpgsql as $$
begin
  if new.provider_timestamp < old.provider_timestamp then
    return old;
  end if;
  return new;
end;
$$;
drop trigger if exists wolv_market_prices_latest_monotonic on public.wolv_market_prices_latest;
create trigger wolv_market_prices_latest_monotonic
  before update on public.wolv_market_prices_latest
  for each row execute function public.wolv_keep_newest_market_price();
