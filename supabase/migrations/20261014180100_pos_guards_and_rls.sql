-- Technical invariants only. Hash/canonicalization and business validation are #36.
create function pos_private.reject_mutation() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'Immutable POS record';
end;
$$;

create function pos_private.guard_chain() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.head_sequence <> 0 or new.head_hash is not null or new.enrollment_generation <> 1 then
      raise exception using errcode = '23514', message = 'New chain must start empty at generation one';
    end if;
    return new;
  end if;
  if row(new.organization_id, new.festival_id, new.chain_id) is distinct from
    row(old.organization_id, old.festival_id, old.chain_id) then
    raise exception using errcode = '55000', message = 'Chain scope is immutable';
  end if;
  if new.enrollment_generation <> old.enrollment_generation then
    if new.enrollment_generation <> old.enrollment_generation + 1 or exists (
      select 1 from pos_private.installations i where i.chain_id = old.chain_id and i.active
    ) then
      raise exception using errcode = '23514', message = 'Retire installation before advancing generation';
    end if;
  end if;
  if row(new.head_sequence, new.head_hash) is distinct from row(old.head_sequence, old.head_hash) then
    if new.head_sequence <> old.head_sequence + 1 or not exists (
      select 1 from pos_private.ledger_events e
      where e.chain_id = old.chain_id and e.sequence = new.head_sequence
        and e.hash = new.head_hash and e.previous_hash is not distinct from old.head_hash
    ) then
      raise exception using errcode = '23514', message = 'Head must advance to the next stored event';
    end if;
  end if;
  return new;
end;
$$;
create trigger chain_guard before insert or update on pos_private.chains
  for each row execute function pos_private.guard_chain();
create trigger chain_no_delete before delete on pos_private.chains
  for each row execute function pos_private.reject_mutation();
create trigger chain_no_truncate before truncate on pos_private.chains
  for each statement execute function pos_private.reject_mutation();

create function pos_private.guard_installation() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare generation bigint;
begin
  select c.enrollment_generation into generation from pos_private.chains c
    where c.organization_id = new.organization_id and c.festival_id = new.festival_id
      and c.chain_id = new.chain_id for update;
  if tg_op = 'UPDATE' then
    if row(new.installation_id, new.organization_id, new.festival_id, new.chain_id,
      new.auth_subject, new.enrollment_generation) is distinct from
      row(old.installation_id, old.organization_id, old.festival_id, old.chain_id,
      old.auth_subject, old.enrollment_generation) or
      (not old.active and (new.active or new.revoked_at is distinct from old.revoked_at)) then
      raise exception using errcode = '55000', message = 'Enrollment identity and retirement are immutable';
    end if;
  end if;
  if new.active and new.enrollment_generation is distinct from generation then
    raise exception using errcode = '23514', message = 'Installation generation is not current';
  end if;
  return new;
end;
$$;
create trigger installation_guard before insert or update on pos_private.installations
  for each row execute function pos_private.guard_installation();
create trigger installation_no_delete before delete on pos_private.installations
  for each row execute function pos_private.reject_mutation();
create trigger installation_no_truncate before truncate on pos_private.installations
  for each statement execute function pos_private.reject_mutation();

create function pos_private.guard_terminal_range() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from pos_private.chains c where c.chain_id = new.chain_id for update;
  if tg_op = 'UPDATE' then
    if row(new.organization_id, new.festival_id, new.chain_id, new.first_sequence, new.terminal_id, new.evidence_reference)
      is distinct from row(old.organization_id, old.festival_id, old.chain_id, old.first_sequence, old.terminal_id, old.evidence_reference)
      or old.last_sequence is not null then
      raise exception using errcode = '55000', message = 'Historical mapping is immutable; only an open range can be closed';
    end if;
    if new.last_sequence is null or exists (
      select 1 from pos_private.ledger_events e where e.chain_id = new.chain_id
        and e.sequence >= new.first_sequence and e.sequence > new.last_sequence
    ) then
      raise exception using errcode = '23514', message = 'Range cannot exclude an existing event';
    end if;
  end if;
  if exists (
    select 1 from pos_private.terminal_ranges r where r.chain_id = new.chain_id
      and (tg_op = 'INSERT' or r.first_sequence <> old.first_sequence)
      and int8range(r.first_sequence, r.last_sequence, '[]') && int8range(new.first_sequence, new.last_sequence, '[]')
  ) then
    raise exception using errcode = '23514', message = 'Terminal ranges overlap';
  end if;
  return new;
end;
$$;
create trigger terminal_range_guard before insert or update on pos_private.terminal_ranges
  for each row execute function pos_private.guard_terminal_range();
create trigger terminal_range_no_delete before delete on pos_private.terminal_ranges
  for each row execute function pos_private.reject_mutation();
create trigger terminal_range_no_truncate before truncate on pos_private.terminal_ranges
  for each statement execute function pos_private.reject_mutation();

create function pos_private.guard_append() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  head pos_private.chains%rowtype;
  original_hash text;
  original_id text;
begin
  select * into head from pos_private.chains c where c.organization_id = new.organization_id
    and c.festival_id = new.festival_id and c.chain_id = new.chain_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'Unknown chain scope';
  end if;
  if exists (select 1 from pos_private.ledger_events e where e.chain_id = new.chain_id
    and (e.event_id = new.event_id or e.sequence = new.sequence)) then
    raise exception using errcode = '23505', message = 'Event identity or sequence already occupied';
  end if;
  if new.sequence <> head.head_sequence + 1 or new.previous_hash is distinct from head.head_hash then
    raise exception using errcode = '23514', message = 'Event does not extend the current head';
  end if;
  if not exists (select 1 from pos_private.terminal_ranges r where r.chain_id = new.chain_id
    and r.terminal_id = new.source_terminal_id and new.sequence >= r.first_sequence
    and (r.last_sequence is null or new.sequence <= r.last_sequence)) then
    raise exception using errcode = '23514', message = 'Historical terminal is not mapped at this sequence';
  end if;
  if new.kind = 'correction' then
    original_id := new.payload_canonical::jsonb #>> '{correction,originalOrderId}';
    select s.sale_hash into original_hash from pos_private.sales s
      where s.organization_id = new.organization_id and s.festival_id = new.festival_id
        and s.chain_id = new.chain_id and s.order_id = original_id;
    if not found then
      raise exception using errcode = '23503', message = 'Original sale is missing in this chain';
    end if;
    if (new.payload_canonical::jsonb #>> '{correction,originalSaleHash}') is distinct from original_hash then
      raise exception using errcode = '23514', message = 'Correction does not reference the original sale hash';
    end if;
  end if;
  return new;
end;
$$;
create trigger ledger_append_guard before insert on pos_private.ledger_events
  for each row execute function pos_private.guard_append();

create function pos_private.advance_head() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.kind = 'sale' then
    insert into pos_private.sales(organization_id, festival_id, chain_id, order_id, ledger_event_id, sale_hash)
      values (new.organization_id, new.festival_id, new.chain_id, new.order_id, new.event_id, new.hash);
  end if;
  update pos_private.chains set head_sequence = new.sequence, head_hash = new.hash
    where chain_id = new.chain_id;
  return new;
end;
$$;
create trigger ledger_advance_head after insert on pos_private.ledger_events
  for each row execute function pos_private.advance_head();

create function pos_private.require_receipt() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare receipt_event_type text; receipt_event_id text;
begin
  if tg_table_name = 'ledger_events' then
    receipt_event_type := 'ledger'; receipt_event_id := new.event_id;
  else
    if new.ledger_event_id is not null then return new; end if;
    receipt_event_type := 'legacy_order'; receipt_event_id := new.order_id;
  end if;
  if not exists (select 1 from pos_private.sync_receipts r where r.organization_id = new.organization_id
    and r.festival_id = new.festival_id and r.chain_id = new.chain_id
    and r.event_type = receipt_event_type and r.event_id = receipt_event_id) then
    raise exception using errcode = '23514', message = 'Financial copy requires a durable receipt in the same transaction';
  end if;
  return new;
end;
$$;
create constraint trigger ledger_receipt_required after insert on pos_private.ledger_events
  deferrable initially deferred for each row execute function pos_private.require_receipt();
create constraint trigger legacy_receipt_required after insert on pos_private.sales
  deferrable initially deferred for each row execute function pos_private.require_receipt();

create function pos_private.guard_receipt() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.event_type = 'legacy_order' and not exists (
    select 1 from pos_private.sales s where s.organization_id = new.organization_id
      and s.festival_id = new.festival_id and s.chain_id = new.chain_id
      and s.order_id = new.legacy_order_id and s.ledger_event_id is null
  ) then
    raise exception using errcode = '23514', message = 'Legacy receipt requires an unsealed order';
  end if;
  return new;
end;
$$;
create trigger receipt_guard before insert on pos_private.sync_receipts
  for each row execute function pos_private.guard_receipt();

do $$
declare t text;
begin
  foreach t in array array['ledger_events', 'sales', 'sync_receipts'] loop
    execute format('create trigger immutable_row before update or delete on pos_private.%I for each row execute function pos_private.reject_mutation()', t);
    execute format('create trigger immutable_table before truncate on pos_private.%I for each statement execute function pos_private.reject_mutation()', t);
  end loop;
end;
$$;

-- The sole definer has SELECT only, no login, no membership for API roles,
-- no BYPASSRLS, and cannot accept an arbitrary subject from a caller.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'pos_policy_reader') then
    create role pos_policy_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'pos_policy_reader' and
    (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'Unsafe existing pos_policy_reader role';
  end if;
end;
$$;
grant pos_policy_reader to postgres;
grant usage on schema pos_private to pos_policy_reader;
grant select on pos_private.organizations, pos_private.festivals, pos_private.chains,
  pos_private.installations, pos_private.scope_grants to pos_policy_reader;
do $$
declare t text;
begin
  foreach t in array array['organizations', 'festivals', 'chains', 'installations', 'scope_grants'] loop
    execute format('create policy authorization_lookup on pos_private.%I for select to pos_policy_reader using (true)', t);
  end loop;
end;
$$;

create function pos_private.can_read_chain(organization uuid, festival uuid, chain uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- Same verified PostgREST claims as auth.uid(), without grants on the managed
  -- auth schema (postgres cannot grant its USAGE to a custom role on Supabase).
  with principal as (
    select coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid as subject
  )
  select principal.subject is not null and exists (
    select 1 from pos_private.chains c
    join pos_private.organizations o on o.organization_id = c.organization_id and o.active
    join pos_private.festivals f on f.organization_id = c.organization_id and f.festival_id = c.festival_id and f.active
    where c.organization_id = organization and c.festival_id = festival and c.chain_id = chain and (
      exists (select 1 from pos_private.installations i where i.chain_id = c.chain_id
        and i.auth_subject = principal.subject and i.active and i.enrollment_generation = c.enrollment_generation)
      or (
        not exists (select 1 from pos_private.installations i where i.auth_subject = principal.subject)
        and exists (select 1 from pos_private.scope_grants g where g.organization_id = c.organization_id
          and g.festival_id = c.festival_id and g.auth_subject = principal.subject and g.active and g.capability = 'read_ledger')
      )
    )
  ) from principal;
$$;
grant create on schema pos_private to pos_policy_reader;
alter function pos_private.can_read_chain(uuid, uuid, uuid) owner to pos_policy_reader;
revoke create on schema pos_private from pos_policy_reader;

revoke all on all functions in schema pos_private from public, anon, authenticated, service_role;
grant usage on schema pos_private to authenticated;
grant execute on function pos_private.can_read_chain(uuid, uuid, uuid) to authenticated;
grant select on pos_private.chains, pos_private.terminal_ranges, pos_private.ledger_events,
  pos_private.sales, pos_private.sync_receipts to authenticated;
do $$
declare t text;
begin
  foreach t in array array['chains', 'terminal_ranges', 'ledger_events', 'sales', 'sync_receipts'] loop
    execute format('create policy authorized_read on pos_private.%I for select to authenticated using (pos_private.can_read_chain(organization_id, festival_id, chain_id))', t);
  end loop;
end;
$$;
-- No public views, RPCs or service_role grants. #36 must add a validated path.
