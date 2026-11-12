-- Configurable, opt-in paper position exits. This migration never touches real wallets or funds.
alter table public.wolv_autonomy_portfolios
  add column if not exists paper_exit_enabled boolean not null default false,
  add column if not exists paper_take_profit_bps integer,
  add column if not exists paper_stop_loss_bps integer,
  add column if not exists paper_max_holding_ms bigint;

alter table public.wolv_autonomy_portfolios
  drop constraint if exists wolv_autonomy_portfolios_paper_take_profit_bps_check,
  drop constraint if exists wolv_autonomy_portfolios_paper_stop_loss_bps_check,
  drop constraint if exists wolv_autonomy_portfolios_paper_max_holding_ms_check;

alter table public.wolv_autonomy_portfolios
  add constraint wolv_autonomy_portfolios_paper_take_profit_bps_check
    check (paper_take_profit_bps is null or paper_take_profit_bps between 1 and 100000),
  add constraint wolv_autonomy_portfolios_paper_stop_loss_bps_check
    check (paper_stop_loss_bps is null or paper_stop_loss_bps between 1 and 10000),
  add constraint wolv_autonomy_portfolios_paper_max_holding_ms_check
    check (paper_max_holding_ms is null or paper_max_holding_ms between 1 and 31536000000),
  add constraint wolv_autonomy_portfolios_paper_exit_rule_required_check
    check (not paper_exit_enabled or
      paper_take_profit_bps is not null or paper_stop_loss_bps is not null or paper_max_holding_ms is not null);

alter table public.wolv_autonomy_positions
  add column if not exists opened_at timestamptz not null default now(),
  add column if not exists realized_pnl_input_units numeric(78,0) not null default 0
    check (realized_pnl_input_units::numeric(78,0) = realized_pnl_input_units);

create table if not exists public.wolv_autonomy_paper_exits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.wolv_autonomy_portfolios(owner_id) on delete cascade,
  exit_intent_id uuid not null,
  chain_id text not null,
  token_address text not null check (token_address ~* '^0x[0-9a-f]{40}$'),
  input_token_address text not null check (input_token_address ~* '^0x[0-9a-f]{40}$'),
  quote_id text not null,
  amount_sold numeric(78,0) not null check (amount_sold > 0),
  gross_proceeds_input_units numeric(78,0) not null check (gross_proceeds_input_units >= 0),
  fee_input_units numeric(78,0) not null check (fee_input_units >= 0),
  net_proceeds_input_units numeric(78,0) not null check (net_proceeds_input_units >= 0),
  cost_basis_released_input_units numeric(78,0) not null check (cost_basis_released_input_units > 0),
  realized_pnl_input_units numeric(78,0) not null,
  exit_reason text not null check (exit_reason in ('TAKE_PROFIT','STOP_LOSS','MAX_HOLDING_TIME')),
  quote_observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(owner_id, exit_intent_id),
  unique(owner_id, quote_id)
);

create index if not exists wolv_autonomy_paper_exits_owner_created_idx
  on public.wolv_autonomy_paper_exits(owner_id, created_at desc);
alter table public.wolv_autonomy_paper_exits enable row level security;
revoke all on public.wolv_autonomy_paper_exits from anon, authenticated;
grant select, insert, update, delete on public.wolv_autonomy_paper_exits to service_role;

-- Atomic and idempotent paper close. Exits reduce exposure even if new-entry strategy
-- has been disabled; only the explicit paper-exit policy and emergency-stop state
-- are checked. No real transaction is signed or broadcast.
create or replace function public.wolv_commit_autonomy_paper_exit(
  p_owner_id uuid,
  p_exit_intent_id uuid,
  p_chain_id text,
  p_token_address text,
  p_input_token_address text,
  p_quote_id text,
  p_amount_sold numeric,
  p_gross_proceeds_input_units numeric,
  p_fee_input_units numeric,
  p_net_proceeds_input_units numeric,
  p_exit_reason text,
  p_quote_observed_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  account public.wolv_autonomy_portfolios%rowtype;
  position public.wolv_autonomy_positions%rowtype;
  prior_exit public.wolv_autonomy_paper_exits%rowtype;
  basis_released numeric(78,0);
  remaining_amount numeric(78,0);
  realized numeric(78,0);
begin
  if p_amount_sold is null or p_amount_sold <= 0 or p_amount_sold <> trunc(p_amount_sold)
     or p_gross_proceeds_input_units is null or p_gross_proceeds_input_units < 0
     or p_gross_proceeds_input_units <> trunc(p_gross_proceeds_input_units)
     or p_fee_input_units is null or p_fee_input_units < 0 or p_fee_input_units <> trunc(p_fee_input_units)
     or p_net_proceeds_input_units is null or p_net_proceeds_input_units < 0
     or p_net_proceeds_input_units <> trunc(p_net_proceeds_input_units)
     or p_net_proceeds_input_units <> greatest(0, p_gross_proceeds_input_units - p_fee_input_units)
     or p_quote_id is null or p_quote_id = ''
     or p_exit_reason is null or p_exit_reason not in ('TAKE_PROFIT','STOP_LOSS','MAX_HOLDING_TIME')
     or p_quote_observed_at is null then return false; end if;

  select * into prior_exit from public.wolv_autonomy_paper_exits
    where owner_id = p_owner_id and exit_intent_id = p_exit_intent_id;
  if found then
    return prior_exit.quote_id = p_quote_id
      and prior_exit.amount_sold = p_amount_sold
      and prior_exit.net_proceeds_input_units = p_net_proceeds_input_units;
  end if;

  select * into account from public.wolv_autonomy_portfolios
    where owner_id = p_owner_id for update;
  if not found or not account.paper_exit_enabled then return false; end if;
  if p_quote_observed_at > now() + interval '5 seconds'
     or p_quote_observed_at < now() - (account.max_quote_age_ms * interval '1 millisecond') then return false; end if;

  select * into position from public.wolv_autonomy_positions
    where owner_id = p_owner_id and chain_id = p_chain_id
      and lower(token_address) = lower(p_token_address) for update;
  if not found or position.amount_units < p_amount_sold or position.amount_units <= 0 then return false; end if;

  if p_chain_id <> account.chain_id or lower(p_input_token_address) <> lower(account.input_token_address) then return false; end if;
  if not exists (
    select 1 from unnest(account.allowed_token_addresses) as allowed(value)
    where lower(allowed.value) = lower(p_token_address)
  ) then return false; end if;

  if p_amount_sold = position.amount_units then
    basis_released := position.cost_basis_input_units;
  else
    basis_released := ceil(position.cost_basis_input_units * p_amount_sold / position.amount_units);
  end if;
  remaining_amount := position.amount_units - p_amount_sold;
  realized := p_net_proceeds_input_units - basis_released;

  insert into public.wolv_autonomy_paper_exits(
    owner_id, exit_intent_id, chain_id, token_address, input_token_address, quote_id,
    amount_sold, gross_proceeds_input_units, fee_input_units, net_proceeds_input_units,
    cost_basis_released_input_units, realized_pnl_input_units, exit_reason, quote_observed_at
  ) values (
    p_owner_id, p_exit_intent_id, p_chain_id, lower(p_token_address), lower(p_input_token_address), p_quote_id,
    p_amount_sold, p_gross_proceeds_input_units, p_fee_input_units, p_net_proceeds_input_units,
    basis_released, realized, p_exit_reason, p_quote_observed_at
  );

  if remaining_amount = 0 then
    delete from public.wolv_autonomy_positions
      where owner_id = p_owner_id and chain_id = p_chain_id and lower(token_address) = lower(p_token_address);
  else
    update public.wolv_autonomy_positions
      set amount_units = remaining_amount,
          cost_basis_input_units = greatest(0, cost_basis_input_units - basis_released),
          realized_pnl_input_units = realized_pnl_input_units + realized,
          updated_at = now()
      where owner_id = p_owner_id and chain_id = p_chain_id and lower(token_address) = lower(p_token_address);
  end if;

  update public.wolv_autonomy_portfolios
    set committed_amount = greatest(0, committed_amount - basis_released),
        updated_at = now()
    where owner_id = p_owner_id;
  return true;
end;
$$;

revoke all on function public.wolv_commit_autonomy_paper_exit(uuid,uuid,text,text,text,text,numeric,numeric,numeric,numeric,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.wolv_commit_autonomy_paper_exit(uuid,uuid,text,text,text,text,numeric,numeric,numeric,numeric,text,timestamptz)
  to service_role;
