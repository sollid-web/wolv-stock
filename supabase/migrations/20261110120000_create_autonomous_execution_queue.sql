-- Durable autonomy queue. This migration intentionally grants writes only to service_role.
create table if not exists public.wolv_execution_intents (
  id uuid primary key,
  owner_id uuid not null,
  idempotency_key text not null,
  state text not null,
  version integer not null default 0 check (version >= 0),
  intent jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);
create index if not exists wolv_execution_intents_owner_state
  on public.wolv_execution_intents (owner_id, state, updated_at desc);

create table if not exists public.wolv_execution_events (
  event_id bigint generated always as identity primary key,
  owner_id uuid not null,
  intent_id uuid not null references public.wolv_execution_intents(id) on delete cascade,
  event_type text not null,
  actor text not null check (actor in ('system','worker','provider','user')),
  occurred_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists wolv_execution_events_intent_time
  on public.wolv_execution_events (intent_id, occurred_at);

create table if not exists public.wolv_execution_leases (
  owner_id uuid not null,
  intent_id uuid not null references public.wolv_execution_intents(id) on delete cascade,
  lease_token uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, intent_id)
);

alter table public.wolv_execution_intents enable row level security;
alter table public.wolv_execution_events enable row level security;
alter table public.wolv_execution_leases enable row level security;
revoke all on public.wolv_execution_intents, public.wolv_execution_events, public.wolv_execution_leases from anon, authenticated;
grant all on public.wolv_execution_intents, public.wolv_execution_events, public.wolv_execution_leases to service_role;

-- Initial event is committed atomically with the intent row.
create or replace function public.wolv_record_initial_execution_event()
returns trigger language plpgsql security definer set search_path = public
as $$
declare event_data jsonb;
begin
  event_data := coalesce(new.intent->'events'->0, '{}'::jsonb);
  insert into public.wolv_execution_events(owner_id, intent_id, event_type, actor, occurred_at, detail)
  values (
    new.owner_id, new.id, coalesce(event_data->>'type', 'INTENT_CREATED'),
    coalesce(event_data->>'actor', 'worker'),
    coalesce((event_data->>'at')::timestamptz, new.created_at),
    coalesce(event_data->'detail', '{}'::jsonb)
  );
  return new;
end;
$$;
drop trigger if exists wolv_execution_intent_initial_event on public.wolv_execution_intents;
create trigger wolv_execution_intent_initial_event
  after insert on public.wolv_execution_intents
  for each row execute function public.wolv_record_initial_execution_event();

-- Version compare, state update and audit append are one database transaction.
create or replace function public.wolv_execution_intent_cas(
  p_owner_id uuid, p_intent_id uuid, p_expected_version integer, p_intent jsonb
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare changed integer; event_data jsonb;
begin
  update public.wolv_execution_intents
  set intent = p_intent,
      state = p_intent->>'state',
      version = (p_intent->>'version')::integer,
      updated_at = (p_intent->>'updatedAt')::timestamptz
  where owner_id = p_owner_id and id = p_intent_id and version = p_expected_version;
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;
  event_data := p_intent->'events'->(jsonb_array_length(p_intent->'events') - 1);
  insert into public.wolv_execution_events(owner_id, intent_id, event_type, actor, occurred_at, detail)
  values (
    p_owner_id, p_intent_id, event_data->>'type', event_data->>'actor',
    (event_data->>'at')::timestamptz, coalesce(event_data->'detail', '{}'::jsonb)
  );
  return true;
end;
$$;

create or replace function public.wolv_acquire_execution_lease(
  p_owner_id uuid, p_intent_id uuid, p_lease_ms integer
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare token uuid := gen_random_uuid();
begin
  if p_lease_ms < 1000 or p_lease_ms > 300000 then
    raise exception 'lease duration must be between 1000 and 300000 ms';
  end if;
  insert into public.wolv_execution_leases(owner_id, intent_id, lease_token, expires_at, updated_at)
  values (p_owner_id, p_intent_id, token, now() + (p_lease_ms * interval '1 millisecond'), now())
  on conflict (owner_id, intent_id) do update
    set lease_token = excluded.lease_token,
        expires_at = excluded.expires_at,
        updated_at = now()
    where public.wolv_execution_leases.expires_at <= now();
  if exists (
    select 1 from public.wolv_execution_leases
    where owner_id = p_owner_id and intent_id = p_intent_id and lease_token = token
  ) then return token; end if;
  return null;
end;
$$;

create or replace function public.wolv_release_execution_lease(
  p_owner_id uuid, p_intent_id uuid, p_lease_token uuid
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare changed integer;
begin
  delete from public.wolv_execution_leases
  where owner_id = p_owner_id and intent_id = p_intent_id and lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.wolv_record_initial_execution_event() from public, anon, authenticated;
revoke all on function public.wolv_execution_intent_cas(uuid,uuid,integer,jsonb) from public, anon, authenticated;
revoke all on function public.wolv_acquire_execution_lease(uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.wolv_release_execution_lease(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.wolv_execution_intent_cas(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.wolv_acquire_execution_lease(uuid,uuid,integer) to service_role;
grant execute on function public.wolv_release_execution_lease(uuid,uuid,uuid) to service_role;
