-- Persist both sides of the RFQ evidence used for a quote-based paper fill.
alter table public.wolv_autonomy_paper_fills
  add column if not exists sell_quote_id text,
  add column if not exists expected_exit_amount_out numeric(78,0),
  add column if not exists roundtrip_edge_bps integer,
  add column if not exists buffered_network_fees_usd numeric(38,18),
  add column if not exists exit_quote_observed_at timestamptz,
  add column if not exists slippage_bps integer;

alter table public.wolv_autonomy_paper_fills
  add constraint wolv_autonomy_paper_fills_sell_quote_id_check
    check (sell_quote_id is null or length(sell_quote_id) between 1 and 128),
  add constraint wolv_autonomy_paper_fills_exit_amount_check
    check (expected_exit_amount_out is null or expected_exit_amount_out > 0),
  add constraint wolv_autonomy_paper_fills_fee_check
    check (buffered_network_fees_usd is null or buffered_network_fees_usd >= 0),
  add constraint wolv_autonomy_paper_fills_slippage_check
    check (slippage_bps is null or slippage_bps between 0 and 5000);

drop function if exists public.wolv_commit_autonomy_paper_fill(uuid,uuid,text,numeric,timestamptz);

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
      and e.value->>'type' = 'BINANCE_ROUNDTRIP_QUOTES_VALIDATED'
      and e.value->'detail'->>'buyQuoteId' = p_quote_id
      and e.value->'detail'->>'sellQuoteId' = p_sell_quote_id
      and e.value->'detail'->>'expectedAmountOut' = p_amount_out::text
      and e.value->'detail'->>'expectedExitAmountOut' = p_expected_exit_amount_out::text
      and e.value->'detail'->>'indicativeRoundTripEdgeBps' = p_roundtrip_edge_bps::text
      and (e.value->'detail'->>'bufferedNetworkFeesUsd')::numeric = p_buffered_network_fees_usd
      and e.value->'detail'->>'slippageBps' = p_slippage_bps::text
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

revoke all on function public.wolv_commit_autonomy_paper_fill(uuid,uuid,text,text,numeric,numeric,integer,numeric,integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.wolv_commit_autonomy_paper_fill(uuid,uuid,text,text,numeric,numeric,integer,numeric,integer,timestamptz,timestamptz) to service_role;
