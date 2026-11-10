-- Portfolio-aware paper capital controls. No real wallet balance is modified.
create table if not exists public.wolv_autonomy_portfolios (
  owner_id uuid primary key,
  wallet_address text not null check (wallet_address ~* '^0x[0-9a-f]{40}$'),
  chain_id text not null,
  input_token_address text not null check (input_token_address ~* '^0x[0-9a-f]{40}$'),
  enabled boolean not null default false,
  emergency_stop boolean not null default true,
  policy_version text not null default 'unconfigured',
  allowed_chain_ids text[] not null default '{}',
  allowed_token_addresses text[] not null default '{}',
  allowed_input_token_addresses text[] not null default '{}',
  paper_budget_amount numeric(78,0) not null default 0 check (paper_budget_amount >= 0),
  reserved_amount numeric(78,0) not null default 0 check (reserved_amount >= 0),
  committed_amount numeric(78,0) not null default 0 check (committed_amount >= 0),
  daily_spend_amount numeric(78,0) not null default 0 check (daily_spend_amount >= 0),
  daily_spend_date date not null default current_date,
  max_order_amount numeric(78,0) not null default 0 check (max_order_amount >= 0),
  max_position_amount numeric(78,0) not null default 0 check (max_position_amount >= 0),
  max_daily_spend numeric(78,0) not null default 0 check (max_daily_spend >= 0),
  max_slippage_bps integer not null default 0 check (max_slippage_bps between 0 and 5000),
  max_price_impact_bps integer not null default 0 check (max_price_impact_bps between 0 and 10000),
  max_quote_age_ms integer not null default 0 check (max_quote_age_ms between 0 and 3600000),
  max_gas_cost_usd numeric(38,18) not null default 0 check (max_gas_cost_usd >= 0),
  min_expected_edge_bps integer not null default 0 check (min_expected_edge_bps between -10000 and 100000),
  updated_at timestamptz not null default now(),
  check (reserved_amount + committed_amount <= paper_budget_amount)
);

create table if not exists public.wolv_autonomy_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wolv_autonomy_portfolios(owner_id) on delete cascade,
  intent_id uuid not null references public.wolv_execution_intents(id) on delete cascade,
  chain_id text not null,
  token_address text not null check (token_address ~* '^0x[0-9a-f]{40}$'),
  input_token_address text not null check (input_token_address ~* '^0x[0-9a-f]{40}$'),
  amount_in numeric(78,0) not null check (amount_in > 0),
  expected_amount_out numeric(78,0) not null check (expected_amount_out > 0),
  policy_version text not null,
  status text not null default 'RESERVED' check (status in ('RESERVED','COMMITTED','RELEASED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, intent_id)
);

create table if not exists public.wolv_autonomy_positions (
  owner_id uuid not null references public.wolv_autonomy_portfolios(owner_id) on delete cascade,
  chain_id text not null,
  token_address text not null check (token_address ~* '^0x[0-9a-f]{40}$'),
  amount_units numeric(78,0) not null default 0 check (amount_units >= 0),
  cost_basis_input_units numeric(78,0) not null default 0 check (cost_basis_input_units >= 0),
  updated_at timestamptz not null default now(),
  primary key(owner_id, chain_id, token_address)
);

create table if not exists public.wolv_autonomy_paper_fills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wolv_autonomy_portfolios(owner_id) on delete cascade,
  intent_id uuid not null,
  quote_id text not null,
  chain_id text not null,
  token_address text not null,
  input_token_address text not null,
  amount_in numeric(78,0) not null check (amount_in > 0),
  amount_out numeric(78,0) not null check (amount_out > 0),
  quote_observed_at timestamptz not null,
  fill_mode text not null default 'PAPER_QUOTE' check (fill_mode = 'PAPER_QUOTE'),
  created_at timestamptz not null default now(),
  unique(owner_id, intent_id)
);

create index if not exists wolv_autonomy_reservations_owner_status_idx
  on public.wolv_autonomy_reservations(owner_id, status, created_at);
create index if not exists wolv_autonomy_positions_owner_token_idx
  on public.wolv_autonomy_positions(owner_id, token_address);

alter table public.wolv_autonomy_portfolios enable row level security;
alter table public.wolv_autonomy_reservations enable row level security;
alter table public.wolv_autonomy_positions enable row level security;
alter table public.wolv_autonomy_paper_fills enable row level security;

revoke all on public.wolv_autonomy_portfolios, public.wolv_autonomy_reservations,
  public.wolv_autonomy_positions, public.wolv_autonomy_paper_fills from anon, authenticated;
grant select, insert, update, delete on public.wolv_autonomy_portfolios,
  public.wolv_autonomy_reservations, public.wolv_autonomy_positions,
  public.wolv_autonomy_paper_fills to service_role;

-- A missing, disabled, stopped, or unconfigured portfolio cannot reserve capital.
create or replace function public.wolv_reserve_autonomy_budget(
  p_owner_id uuid,
  p_intent_id uuid,
  p_chain_id text,
  p_token_address text,
  p_input_token_address text,
  p_amount_in numeric,
  p_expected_amount_out numeric,
  p_policy_version text
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  account public.wolv_autonomy_portfolios%rowtype;
  existing public.wolv_autonomy_reservations%rowtype;
  position_cost numeric(78,0);
  position_reserved numeric(78,0);
  daily_reserved numeric(78,0);
begin
  if p_amount_in is null or p_amount_in <= 0 or p_amount_in <> trunc(p_amount_in)
     or p_expected_amount_out is null or p_expected_amount_out <= 0
     or p_expected_amount_out <> trunc(p_expected_amount_out) then
    return false;
  end if;

  select * into existing
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and intent_id = p_intent_id
  for update;
  if found then
    return existing.status = 'RESERVED'
      and existing.amount_in = p_amount_in
      and existing.expected_amount_out = p_expected_amount_out
      and lower(existing.token_address) = lower(p_token_address)
      and existing.policy_version = p_policy_version;
  end if;

  select * into account
  from public.wolv_autonomy_portfolios
  where owner_id = p_owner_id
  for update;
  if not found or not account.enabled or account.emergency_stop then return false; end if;
  if account.policy_version <> p_policy_version then return false; end if;
  if not (p_chain_id = any(account.allowed_chain_ids)) then return false; end if;
  if not exists(select 1 from unnest(account.allowed_token_addresses) as a(value) where lower(a.value) = lower(p_token_address)) then return false; end if;
  if not exists(select 1 from unnest(account.allowed_input_token_addresses) as a(value) where lower(a.value) = lower(p_input_token_address)) then return false; end if;
  if lower(p_input_token_address) <> lower(account.input_token_address) or p_chain_id <> account.chain_id then return false; end if;
  if p_amount_in > account.max_order_amount then return false; end if;
  if not exists (
    select 1 from public.wolv_execution_intents
    where owner_id = p_owner_id and id = p_intent_id
      and intent->>'state' = 'RISK_APPROVED'
      and lower(intent->>'walletAddress') = lower(account.wallet_address)
      and intent->>'policyVersion' = p_policy_version
      and intent->>'chainId' = p_chain_id
      and lower(intent->>'tokenAddress') = lower(p_token_address)
      and lower(intent->>'inputTokenAddress') = lower(p_input_token_address)
      and intent->>'amountIn' = p_amount_in::text
      and intent->>'quoteId' is not null
      and (intent->>'quoteExpiresAt')::timestamptz > now()
      and exists (
        select 1 from jsonb_array_elements(intent->'events') as ev(value)
        where ev.value->>'type' = 'BINANCE_EXECUTABLE_QUOTE_VALIDATED'
          and ev.value->'detail'->>'expectedAmountOut' = p_expected_amount_out::text
      )
  ) then return false; end if;

  if account.daily_spend_date < current_date then
    update public.wolv_autonomy_portfolios
      set daily_spend_amount = 0, daily_spend_date = current_date, updated_at = now()
      where owner_id = p_owner_id;
    account.daily_spend_amount := 0;
    account.daily_spend_date := current_date;
  end if;

  select coalesce(sum(cost_basis_input_units), 0) into position_cost
  from public.wolv_autonomy_positions
  where owner_id = p_owner_id and chain_id = p_chain_id and lower(token_address) = lower(p_token_address);

  select coalesce(sum(amount_in), 0) into position_reserved
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and chain_id = p_chain_id
    and lower(token_address) = lower(p_token_address) and status = 'RESERVED';

  select coalesce(sum(amount_in), 0) into daily_reserved
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and status = 'RESERVED' and created_at::date = current_date;

  if position_cost + position_reserved + p_amount_in > account.max_position_amount then return false; end if;
  if account.committed_amount + account.reserved_amount + p_amount_in > account.paper_budget_amount then return false; end if;
  if account.daily_spend_amount + daily_reserved + p_amount_in > account.max_daily_spend then return false; end if;

  insert into public.wolv_autonomy_reservations(
    owner_id, intent_id, chain_id, token_address, input_token_address,
    amount_in, expected_amount_out, policy_version
  ) values (
    p_owner_id, p_intent_id, p_chain_id, lower(p_token_address), lower(p_input_token_address),
    p_amount_in, p_expected_amount_out, p_policy_version
  );

  update public.wolv_autonomy_portfolios
    set reserved_amount = reserved_amount + p_amount_in, updated_at = now()
    where owner_id = p_owner_id;
  return true;
end;
$$;

create or replace function public.wolv_release_autonomy_budget(
  p_owner_id uuid, p_intent_id uuid
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare reservation public.wolv_autonomy_reservations%rowtype;
begin
  select * into reservation
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and intent_id = p_intent_id
  for update;
  if not found then return false; end if;
  if reservation.status = 'RELEASED' then return true; end if;
  if reservation.status <> 'RESERVED' then return false; end if;

  update public.wolv_autonomy_portfolios
    set reserved_amount = greatest(0, reserved_amount - reservation.amount_in), updated_at = now()
    where owner_id = p_owner_id;
  update public.wolv_autonomy_reservations
    set status = 'RELEASED', updated_at = now()
    where owner_id = p_owner_id and intent_id = p_intent_id;
  return true;
end;
$$;

-- Commits a paper quote fill exactly once. It does not represent a real trade or settlement.
create or replace function public.wolv_commit_autonomy_paper_fill(
  p_owner_id uuid,
  p_intent_id uuid,
  p_quote_id text,
  p_amount_out numeric,
  p_quote_observed_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  reservation public.wolv_autonomy_reservations%rowtype;
  account public.wolv_autonomy_portfolios%rowtype;
begin
  if p_amount_out is null or p_amount_out <= 0 or p_amount_out <> trunc(p_amount_out)
     or p_quote_id is null or p_quote_id = '' or p_quote_observed_at is null then
    return false;
  end if;

  select * into reservation
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and intent_id = p_intent_id
  for update;
  if not found then return false; end if;
  if reservation.status = 'COMMITTED' then
    return exists(select 1 from public.wolv_autonomy_paper_fills where owner_id = p_owner_id and intent_id = p_intent_id and quote_id = p_quote_id);
  end if;
  if reservation.status <> 'RESERVED' or reservation.expected_amount_out <> p_amount_out then return false; end if;

  select * into account
  from public.wolv_autonomy_portfolios
  where owner_id = p_owner_id
  for update;
  if not found then return false; end if;
  if not account.enabled or account.emergency_stop then return false; end if;
  if account.policy_version <> reservation.policy_version then return false; end if;
  if not exists (
    select 1 from public.wolv_execution_intents
    where owner_id = p_owner_id and id = p_intent_id
      and intent->>'state' = 'SIMULATED' and intent->>'quoteId' = p_quote_id
      and (intent->>'quoteExpiresAt')::timestamptz > now()
  ) then return false; end if;
  if p_quote_observed_at > now() + interval '5 seconds' then return false; end if;
  if account.daily_spend_date < current_date then
    update public.wolv_autonomy_portfolios
      set daily_spend_amount = 0, daily_spend_date = current_date
      where owner_id = p_owner_id;
    account.daily_spend_amount := 0;
  end if;
  if p_quote_observed_at < now() - (account.max_quote_age_ms * interval '1 millisecond') then return false; end if;
  if account.daily_spend_amount + reservation.amount_in > account.max_daily_spend then return false; end if;

  insert into public.wolv_autonomy_paper_fills(
    owner_id, intent_id, quote_id, chain_id, token_address, input_token_address,
    amount_in, amount_out, quote_observed_at
  ) values (
    p_owner_id, p_intent_id, p_quote_id, reservation.chain_id, reservation.token_address,
    reservation.input_token_address, reservation.amount_in, p_amount_out, p_quote_observed_at
  );

  update public.wolv_autonomy_positions
    set amount_units = amount_units + p_amount_out,
        cost_basis_input_units = cost_basis_input_units + reservation.amount_in,
        updated_at = now()
    where owner_id = p_owner_id and chain_id = reservation.chain_id and lower(token_address) = lower(reservation.token_address);
  if not found then
    insert into public.wolv_autonomy_positions(
      owner_id, chain_id, token_address, amount_units, cost_basis_input_units
    ) values (
      p_owner_id, reservation.chain_id, reservation.token_address, p_amount_out, reservation.amount_in
    );
  end if;

  update public.wolv_autonomy_portfolios
    set reserved_amount = greatest(0, reserved_amount - reservation.amount_in),
        committed_amount = committed_amount + reservation.amount_in,
        daily_spend_amount = daily_spend_amount + reservation.amount_in,
        daily_spend_date = current_date,
        updated_at = now()
    where owner_id = p_owner_id;
  update public.wolv_autonomy_reservations
    set status = 'COMMITTED', updated_at = now()
    where owner_id = p_owner_id and intent_id = p_intent_id;
  return true;
end;
$$;

revoke all on function public.wolv_reserve_autonomy_budget(uuid,uuid,text,text,text,numeric,numeric,text) from public, anon, authenticated;
revoke all on function public.wolv_release_autonomy_budget(uuid,uuid) from public, anon, authenticated;
revoke all on function public.wolv_commit_autonomy_paper_fill(uuid,uuid,text,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.wolv_reserve_autonomy_budget(uuid,uuid,text,text,text,numeric,numeric,text) to service_role;
grant execute on function public.wolv_release_autonomy_budget(uuid,uuid) to service_role;
grant execute on function public.wolv_commit_autonomy_paper_fill(uuid,uuid,text,numeric,timestamptz) to service_role;
