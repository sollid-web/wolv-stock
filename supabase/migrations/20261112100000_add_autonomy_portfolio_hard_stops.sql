-- Additional hard stops for autonomous portfolio breadth and realized losses.
-- Defaults remain conservative; existing disabled portfolios stay disabled.
alter table public.wolv_autonomy_portfolios
  add column if not exists max_open_positions integer not null default 1,
  add column if not exists max_daily_realized_loss numeric(78,0) not null default 1;

alter table public.wolv_autonomy_portfolios
  drop constraint if exists wolv_autonomy_portfolios_max_open_positions_check,
  drop constraint if exists wolv_autonomy_portfolios_max_daily_realized_loss_check;

alter table public.wolv_autonomy_portfolios
  add constraint wolv_autonomy_portfolios_max_open_positions_check
    check (max_open_positions between 1 and 100),
  add constraint wolv_autonomy_portfolios_max_daily_realized_loss_check
    check (max_daily_realized_loss > 0 and max_daily_realized_loss = trunc(max_daily_realized_loss));

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
  open_position_count integer;
  daily_realized_loss numeric(78,0);
  candidate_already_open boolean;
  utc_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
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
  where owner_id = p_owner_id and status = 'RESERVED' and created_at >= utc_day_start;

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
  realized_losses as (
    select coalesce(sum(-e.realized_pnl_input_units), 0) as loss
    from public.wolv_autonomy_paper_exits e, utc_window w
    where e.owner_id = p_owner_id and e.realized_pnl_input_units < 0
      and e.created_at >= w.day_start and e.created_at < w.day_start + interval '1 day'
  )
  select (select count(*) from active_positions), realized_losses.loss::text
  from realized_losses;
$$;

revoke all on function public.wolv_get_autonomy_risk_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.wolv_get_autonomy_risk_snapshot(uuid) to service_role;
