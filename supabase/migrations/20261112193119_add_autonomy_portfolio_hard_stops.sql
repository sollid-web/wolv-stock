-- One operator-wide stop applies to every owner and strategy. New installations
-- start stopped; only the server-side control function may release it.
create table if not exists public.wolv_autonomy_global_control (
  singleton boolean primary key default true check (singleton = true),
  kill_switch boolean not null default true,
  reason text not null default 'INITIAL_FAIL_CLOSED',
  updated_at timestamptz not null default now()
);
insert into public.wolv_autonomy_global_control(singleton, kill_switch, reason)
values (true, true, 'INITIAL_FAIL_CLOSED')
on conflict (singleton) do nothing;
alter table public.wolv_autonomy_global_control enable row level security;
revoke all on public.wolv_autonomy_global_control from anon, authenticated;
grant select on public.wolv_autonomy_global_control to service_role;

-- Additional hard stops for autonomous portfolio breadth and realized losses.
-- Defaults remain conservative; existing disabled portfolios stay disabled.
alter table public.wolv_autonomy_portfolios
  add column if not exists max_open_positions integer not null default 1,
  add column if not exists max_open_orders integer not null default 1,
  add column if not exists max_daily_realized_loss numeric(78,0) not null default 1,
  add column if not exists min_native_gas_balance_wei numeric(78,0) not null default 0;

alter table public.wolv_autonomy_portfolios
  drop constraint if exists wolv_autonomy_portfolios_max_open_positions_check,
  drop constraint if exists wolv_autonomy_portfolios_max_open_orders_check,
  drop constraint if exists wolv_autonomy_portfolios_max_daily_realized_loss_check,
  drop constraint if exists wolv_autonomy_portfolios_min_native_gas_balance_wei_check;

alter table public.wolv_autonomy_portfolios
  add constraint wolv_autonomy_portfolios_max_open_positions_check
    check (max_open_positions between 1 and 100),
  add constraint wolv_autonomy_portfolios_max_open_orders_check
    check (max_open_orders between 1 and 100),
  add constraint wolv_autonomy_portfolios_max_daily_realized_loss_check
    check (max_daily_realized_loss > 0 and max_daily_realized_loss = trunc(max_daily_realized_loss)),
  add constraint wolv_autonomy_portfolios_min_native_gas_balance_wei_check
    check (min_native_gas_balance_wei >= 0 and min_native_gas_balance_wei = trunc(min_native_gas_balance_wei));

update public.wolv_autonomy_portfolios
set max_daily_realized_loss = greatest(max_daily_spend, 1)
where max_daily_realized_loss = 1;

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
  open_position_count bigint;
  open_order_count bigint;
  daily_realized_loss numeric(78,0);
  candidate_already_open boolean;
  global_kill_switch boolean;
  utc_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_amount_in is null or p_amount_in <= 0 or p_amount_in <> trunc(p_amount_in)
     or p_expected_amount_out is null or p_expected_amount_out <= 0
     or p_expected_amount_out <> trunc(p_expected_amount_out) then
    return false;
  end if;

  select kill_switch into global_kill_switch
  from public.wolv_autonomy_global_control
  where singleton = true
  for share;
  if not found or global_kill_switch then return false; end if;

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
        where ev.value->>'type' in ('BINANCE_ROUNDTRIP_QUOTES_VALIDATED','PROVIDER_ROUNDTRIP_QUOTES_VALIDATED')
          and ev.value->'detail'->>'buyQuoteId' = intent->>'quoteId'
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
  where owner_id = p_owner_id and status = 'RESERVED'
    and created_at >= utc_day_start and created_at < utc_day_start + interval '1 day';

  select count(*) into open_order_count
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and status = 'RESERVED';

  select count(*) into open_position_count
  from (
    select chain_id, lower(token_address) as token_address
    from public.wolv_autonomy_positions
    where owner_id = p_owner_id and amount_units > 0
    union
    select chain_id, lower(token_address) as token_address
    from public.wolv_autonomy_reservations
    where owner_id = p_owner_id and status = 'RESERVED'
  ) active_positions;

  select exists (
    select 1 from public.wolv_autonomy_positions
    where owner_id = p_owner_id and chain_id = p_chain_id
      and lower(token_address) = lower(p_token_address) and amount_units > 0
    union all
    select 1 from public.wolv_autonomy_reservations
    where owner_id = p_owner_id and chain_id = p_chain_id
      and lower(token_address) = lower(p_token_address) and status = 'RESERVED'
  ) into candidate_already_open;

  select coalesce(sum(-realized_pnl_input_units), 0) into daily_realized_loss
  from public.wolv_autonomy_paper_exits
  where owner_id = p_owner_id and realized_pnl_input_units < 0
    and created_at >= utc_day_start and created_at < utc_day_start + interval '1 day';

  if not candidate_already_open and open_position_count >= account.max_open_positions then return false; end if;
  if open_order_count >= account.max_open_orders then return false; end if;
  if daily_realized_loss >= account.max_daily_realized_loss then return false; end if;
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


-- One bounded database snapshot avoids PostgREST row limits truncating loss
-- totals or concurrent-position counts in the worker's risk evaluation.
create or replace function public.wolv_get_autonomy_risk_snapshot(
  p_owner_id uuid
) returns table (
  open_positions bigint,
  open_orders bigint,
  daily_realized_loss text
)
language sql stable security definer set search_path = public
as $$
  with utc_window as (
    select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as day_start
  ),
  active_positions as (
    select chain_id, lower(token_address) as token_address
    from public.wolv_autonomy_positions
    where owner_id = p_owner_id and amount_units > 0
    union
    select chain_id, lower(token_address) as token_address
    from public.wolv_autonomy_reservations
    where owner_id = p_owner_id and status = 'RESERVED'
  ),
  active_orders as (
    select count(*) as total from public.wolv_autonomy_reservations
    where owner_id = p_owner_id and status = 'RESERVED'
  ),
  realized_losses as (
    select coalesce(sum(-e.realized_pnl_input_units), 0) as loss
    from public.wolv_autonomy_paper_exits e, utc_window w
    where e.owner_id = p_owner_id and e.realized_pnl_input_units < 0
      and e.created_at >= w.day_start and e.created_at < w.day_start + interval '1 day'
  )
  select (select count(*) from active_positions), active_orders.total, realized_losses.loss::text
  from realized_losses cross join active_orders;
$$;

revoke all on function public.wolv_get_autonomy_risk_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.wolv_get_autonomy_risk_snapshot(uuid) to service_role;


-- Keep paper-fill commit compatible with both legacy and provider-neutral audit events.
create or replace function public.wolv_commit_autonomy_paper_fill(
  p_owner_id uuid,
  p_intent_id uuid,
  p_quote_id text,
  p_sell_quote_id text,
  p_amount_out numeric,
  p_expected_exit_amount_out numeric,
  p_roundtrip_edge_bps integer,
  p_buffered_network_fees_usd numeric,
  p_slippage_bps integer,
  p_quote_observed_at timestamptz,
  p_exit_quote_observed_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  reservation public.wolv_autonomy_reservations%rowtype;
  account public.wolv_autonomy_portfolios%rowtype;
  global_kill_switch boolean;
begin
  if p_amount_out is null or p_amount_out <= 0 or p_amount_out <> trunc(p_amount_out)
     or p_expected_exit_amount_out is null or p_expected_exit_amount_out <= 0 or p_expected_exit_amount_out <> trunc(p_expected_exit_amount_out)
     or p_roundtrip_edge_bps is null or p_roundtrip_edge_bps < 0
     or p_buffered_network_fees_usd is null or p_buffered_network_fees_usd < 0
     or p_slippage_bps is null or p_slippage_bps < 0 or p_slippage_bps > 5000
     or p_quote_id is null or p_quote_id = '' or p_sell_quote_id is null or p_sell_quote_id = ''
     or p_quote_observed_at is null or p_exit_quote_observed_at is null then
    return false;
  end if;

  select kill_switch into global_kill_switch
  from public.wolv_autonomy_global_control
  where singleton = true
  for share;
  if not found then global_kill_switch := true; end if;

  select * into reservation
  from public.wolv_autonomy_reservations
  where owner_id = p_owner_id and intent_id = p_intent_id
  for update;
  if not found then return false; end if;
  if reservation.status = 'COMMITTED' then
    return exists(
      select 1 from public.wolv_autonomy_paper_fills
      where owner_id = p_owner_id and intent_id = p_intent_id
        and quote_id = p_quote_id and sell_quote_id = p_sell_quote_id
        and amount_out = p_amount_out and expected_exit_amount_out = p_expected_exit_amount_out
    );
  end if;
  if global_kill_switch then return false; end if;
  if reservation.status <> 'RESERVED' or reservation.expected_amount_out <> p_amount_out then return false; end if;

  select * into account
  from public.wolv_autonomy_portfolios
  where owner_id = p_owner_id
  for update;
  if not found then return false; end if;
  if not account.enabled or account.emergency_stop then return false; end if;
  if account.policy_version <> reservation.policy_version then return false; end if;
  if not exists (
    select 1
    from public.wolv_execution_intents i
    cross join lateral jsonb_array_elements(i.intent->'events') e(value)
    where i.owner_id = p_owner_id and i.id = p_intent_id
      and i.intent->>'state' = 'SIMULATED'
      and i.intent->>'quoteId' = p_quote_id
      and (i.intent->>'quoteExpiresAt')::timestamptz > now()
      and e.value->>'type' in ('BINANCE_ROUNDTRIP_QUOTES_VALIDATED','PROVIDER_ROUNDTRIP_QUOTES_VALIDATED')
      and e.value->'detail'->>'buyQuoteId' = p_quote_id
      and e.value->'detail'->>'sellQuoteId' = p_sell_quote_id
      and e.value->'detail'->>'expectedAmountOut' = p_amount_out::text
      and e.value->'detail'->>'expectedExitAmountOut' = p_expected_exit_amount_out::text
      and e.value->'detail'->>'indicativeRoundTripEdgeBps' = p_roundtrip_edge_bps::text
      and (e.value->'detail'->>'bufferedNetworkFeesUsd')::numeric = p_buffered_network_fees_usd
      and e.value->'detail'->>'slippageBps' = p_slippage_bps::text
      and (e.value->'detail'->>'buyObservedAt')::timestamptz = p_quote_observed_at
      and (e.value->'detail'->>'sellObservedAt')::timestamptz = p_exit_quote_observed_at
  ) then return false; end if;
  if p_quote_observed_at > now() + interval '5 seconds'
     or p_exit_quote_observed_at > now() + interval '5 seconds' then return false; end if;
  if account.daily_spend_date < current_date then
    update public.wolv_autonomy_portfolios
      set daily_spend_amount = 0, daily_spend_date = current_date
      where owner_id = p_owner_id;
    account.daily_spend_amount := 0;
  end if;
  if p_quote_observed_at < now() - (account.max_quote_age_ms * interval '1 millisecond')
     or p_exit_quote_observed_at < now() - (account.max_quote_age_ms * interval '1 millisecond') then return false; end if;
  if account.daily_spend_amount + reservation.amount_in > account.max_daily_spend then return false; end if;

  insert into public.wolv_autonomy_paper_fills(
    owner_id, intent_id, quote_id, sell_quote_id, chain_id, token_address, input_token_address,
    amount_in, amount_out, expected_exit_amount_out, roundtrip_edge_bps,
    buffered_network_fees_usd, quote_observed_at, exit_quote_observed_at, slippage_bps
  ) values (
    p_owner_id, p_intent_id, p_quote_id, p_sell_quote_id, reservation.chain_id,
    reservation.token_address, reservation.input_token_address, reservation.amount_in,
    p_amount_out, p_expected_exit_amount_out, p_roundtrip_edge_bps,
    p_buffered_network_fees_usd, p_quote_observed_at, p_exit_quote_observed_at, p_slippage_bps
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


create or replace function public.wolv_set_autonomy_global_kill_switch(
  p_kill_switch boolean,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if p_kill_switch is null or p_reason is null or length(trim(p_reason)) < 3 or length(p_reason) > 300 then
    return false;
  end if;
  update public.wolv_autonomy_global_control
    set kill_switch = p_kill_switch, reason = trim(p_reason), updated_at = now()
    where singleton = true;
  return found;
end;
$$;
revoke all on function public.wolv_set_autonomy_global_kill_switch(boolean, text) from public, anon, authenticated;
grant execute on function public.wolv_set_autonomy_global_kill_switch(boolean, text) to service_role;
