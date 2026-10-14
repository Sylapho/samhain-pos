-- samhain-sync/1 identity extension. Financial payloads and heads are untouched.
create table pos_private.enrollment_requests (
  request_id uuid primary key default gen_random_uuid(),
  auth_subject uuid not null unique references auth.users(id),
  installation_id uuid not null unique,
  public_key text not null check (length(public_key) between 300 and 1000),
  dossier jsonb not null check (jsonb_typeof(dossier) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  organization_id uuid,
  festival_id uuid,
  chain_id uuid,
  approved_by uuid references auth.users(id),
  invitation_hash text check (invitation_hash ~ '^[0-9a-f]{64}$'),
  invitation_expires_at timestamptz,
  consumed_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  replaces_installation_id uuid,
  foreign key (organization_id, festival_id) references pos_private.festivals
);
create unique index enrollment_invitation_once on pos_private.enrollment_requests(invitation_hash) where invitation_hash is not null;
create table pos_private.installation_keys (
  installation_id uuid primary key references pos_private.installations,
  public_key text not null,
  continuity_state text not null check (continuity_state in ('ready', 'needs_recovery')),
  request_id uuid not null unique references pos_private.enrollment_requests
);
create table pos_private.auth_challenges (
  auth_subject uuid primary key references auth.users(id),
  installation_id uuid not null,
  nonce uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null default clock_timestamp() + interval '60 seconds',
  issued_at timestamptz not null default clock_timestamp(),
  window_started_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 1
);
create table pos_private.enrollment_audit (
  incident_id uuid primary key default gen_random_uuid(),
  auth_subject uuid not null references auth.users(id),
  request_id uuid references pos_private.enrollment_requests,
  action text not null,
  recorded_at timestamptz not null default clock_timestamp()
);

-- A bounded owner can change enrollment only, never financial events/receipts.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'pos_enrollment_executor') then
    create role pos_enrollment_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pos_enrollment_executor' and
    (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
    or pg_has_role('anon','pos_enrollment_executor','MEMBER')
    or pg_has_role('authenticated','pos_enrollment_executor','MEMBER')
    or pg_has_role('service_role','pos_enrollment_executor','MEMBER') then
    raise exception 'Unsafe existing pos_enrollment_executor role';
  end if;
end $$;
grant pos_enrollment_executor to postgres;
grant usage on schema pos_private to pos_enrollment_executor;
grant select on pos_private.organizations, pos_private.festivals, pos_private.scope_grants,
  pos_private.chains, pos_private.installations, pos_private.terminal_ranges,
  pos_private.ledger_events to pos_enrollment_executor;
grant insert on pos_private.chains, pos_private.installations, pos_private.terminal_ranges to pos_enrollment_executor;
grant update (enrollment_generation) on pos_private.chains to pos_enrollment_executor;
grant update (active, revoked_at) on pos_private.installations to pos_enrollment_executor;
grant select, insert, update on pos_private.enrollment_requests, pos_private.auth_challenges to pos_enrollment_executor;
grant select, insert on pos_private.installation_keys to pos_enrollment_executor;
grant insert on pos_private.enrollment_audit to pos_enrollment_executor;
grant execute on function pos_private.guard_chain(), pos_private.guard_installation(),
  pos_private.guard_terminal_range() to pos_enrollment_executor;
do $$ declare t text; begin
  foreach t in array array['enrollment_requests','installation_keys','auth_challenges','enrollment_audit'] loop
    execute format('alter table pos_private.%I enable row level security', t);
    execute format('alter table pos_private.%I force row level security', t);
    execute format('revoke all on pos_private.%I from public, anon, authenticated, service_role', t);
  end loop;
  foreach t in array array['organizations','festivals','scope_grants','chains','installations',
    'terminal_ranges','ledger_events','enrollment_requests','installation_keys','auth_challenges','enrollment_audit'] loop
    execute format('create policy enrollment_executor on pos_private.%I to pos_enrollment_executor using (true) with check (true)', t);
  end loop;
end $$;

create function pos_private.require_manager(subject uuid, organization uuid, festival uuid) returns void
language plpgsql security invoker set search_path = '' as $$ begin
  if subject is null or exists (select 1 from pos_private.installations where auth_subject = subject)
    or not exists (
      select 1 from pos_private.scope_grants g
      join pos_private.organizations o using (organization_id)
      join pos_private.festivals f using (organization_id, festival_id)
      where g.auth_subject = subject and g.organization_id = organization and g.festival_id = festival
        and g.capability = 'manage_enrollment' and g.active and o.active and f.active
    ) then raise exception using errcode = '42501', message = 'MANAGER_REQUIRED'; end if;
end $$;

-- Future ingestion calls this INSIDE its financial transaction, under the same chain lock.
create function pos_private.require_installation(subject uuid, context jsonb) returns void
language plpgsql security invoker set search_path = '' as $$ declare c pos_private.chains%rowtype; begin
  select * into c from pos_private.chains where chain_id = (context->>'chainId')::uuid for update;
  if not found or not exists (
    select 1 from pos_private.installations i
    join pos_private.organizations o using (organization_id)
    join pos_private.festivals f using (organization_id, festival_id)
    join pos_private.installation_keys k using (installation_id)
    where i.auth_subject = subject and i.installation_id = (context->>'installationId')::uuid
      and i.chain_id = c.chain_id and i.organization_id = (context->>'organizationId')::uuid
      and i.festival_id = (context->>'festivalId')::uuid and i.active and o.active and f.active
      and i.enrollment_generation = c.enrollment_generation
      and i.enrollment_generation = (context->>'enrollmentGeneration')::bigint
      and k.continuity_state = 'ready'
  ) then raise exception using errcode = '42501', message = 'INSTALLATION_DENIED'; end if;
  if context ? 'terminalId' and not exists (
    select 1 from pos_private.terminal_ranges r where r.chain_id = c.chain_id
      and r.terminal_id = context->>'terminalId' and (context->>'sequence')::bigint >= r.first_sequence
      and (r.last_sequence is null or (context->>'sequence')::bigint <= r.last_sequence)
  ) then raise exception using errcode = '42501', message = 'TERMINAL_DENIED'; end if;
end $$;

create function pos_private.consume_installation_proof(subject uuid, context jsonb, nonce uuid) returns void
language plpgsql security invoker set search_path = '' as $$ begin
  update pos_private.auth_challenges ch set expires_at = '-infinity'
    where ch.auth_subject = subject and ch.nonce = consume_installation_proof.nonce
      and ch.installation_id = (context->>'installationId')::uuid and ch.expires_at > clock_timestamp();
  if not found then raise exception using errcode = '42501', message = 'PROOF_REQUIRED'; end if;
  perform pos_private.require_installation(subject,context);
end $$;
revoke all on function pos_private.consume_installation_proof(uuid,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function pos_private.consume_installation_proof(uuid,jsonb,uuid) to pos_enrollment_executor;

-- Every device operation consumes a verified proof challenge atomically.
-- subject comes ONLY from Auth.getUser in the Edge, never from the HTTP body.
create function public.tablet_auth_v1(subject uuid, action text, body jsonb, proof_nonce uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r pos_private.enrollment_requests%rowtype;
  c pos_private.chains%rowtype;
  i pos_private.installations%rowtype;
  target uuid;
  nonce uuid;
  key text;
  recovery boolean;
  prefix jsonb;
  item jsonb;
  last_terminal text;
  first_seq bigint;
  index_seq bigint := 0;
begin
  if subject is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if action = 'request' then
    if exists (select 1 from pos_private.installations where auth_subject = subject) then
      raise exception using errcode = '42501', message = 'NEW_PRINCIPAL_REQUIRED';
    end if;
    if octet_length(body::text) > 1048576 or jsonb_array_length(body->'prefix') > 10000
      or body->>'publicKey' is null or body->>'terminalId' is null
      or length(body->>'terminalId') not between 1 and 512 then
      raise exception using errcode = '22023', message = 'INVALID_DOSSIER';
    end if;
    prefix := body->'prefix';
    if prefix is null or jsonb_typeof(prefix) <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_PREFIX';
    end if;
    for item in select value from jsonb_array_elements(prefix) loop
      index_seq := index_seq + 1;
      if (item->>'sequence')::bigint is distinct from index_seq or (item->>'hash' ~ '^[0-9a-f]{64}$') is not true
        or nullif(item->>'eventId','') is null or nullif(item->>'terminalId','') is null
        or octet_length(item->>'eventId') > 512 or octet_length(item->>'terminalId') > 512 then
        raise exception using errcode = '22023', message = 'INVALID_PREFIX';
      end if;
    end loop;
    insert into pos_private.enrollment_requests(auth_subject, installation_id, public_key, dossier)
      values (subject, (body->>'installationId')::uuid, body->>'publicKey', body)
      on conflict (auth_subject) do nothing;
    select * into r from pos_private.enrollment_requests where auth_subject = subject;
    if r.installation_id <> (body->>'installationId')::uuid or r.public_key <> body->>'publicKey'
      or r.dossier <> body then raise exception using errcode = '42501', message = 'REQUEST_CONFLICT'; end if;
    return jsonb_build_object('status','pending','requestId',r.request_id);
  elsif action = 'challenge' then
    target := (body->>'installationId')::uuid;
    select public_key into key from pos_private.enrollment_requests where auth_subject = subject and installation_id = target;
    if key is null then raise exception using errcode = '42501', message = 'INSTALLATION_DENIED'; end if;
    if exists (select 1 from pos_private.auth_challenges ch where ch.auth_subject = subject
      and ch.window_started_at > clock_timestamp() - interval '1 minute' and ch.attempts >= 60) then
      raise exception using errcode = '42501', message = 'RATE_LIMITED'; end if;
    insert into pos_private.auth_challenges(auth_subject, installation_id) values (subject,target)
      on conflict (auth_subject) do update set nonce = gen_random_uuid(), expires_at = clock_timestamp() + interval '60 seconds', installation_id = target,
        issued_at = clock_timestamp(), window_started_at = case when auth_challenges.window_started_at <= clock_timestamp() - interval '1 minute' then clock_timestamp() else auth_challenges.window_started_at end,
        attempts = case when auth_challenges.window_started_at <= clock_timestamp() - interval '1 minute' then 1 else auth_challenges.attempts + 1 end
      returning auth_challenges.nonce into nonce;
    return jsonb_build_object('nonce',nonce,'publicKey',key);
  elsif action = 'proof' then
    select er.public_key into key from pos_private.auth_challenges ch
      join pos_private.enrollment_requests er using(auth_subject,installation_id)
      where ch.auth_subject = subject and ch.installation_id = (body->>'installationId')::uuid
        and ch.nonce = (body->>'nonce')::uuid and ch.expires_at > clock_timestamp();
    if key is null then raise exception using errcode = '42501', message = 'PROOF_REQUIRED'; end if;
    return jsonb_build_object('publicKey',key);
  elsif action = 'approve' then
    select * into r from pos_private.enrollment_requests where request_id = (body->>'requestId')::uuid for update;
    if not found then raise exception using errcode = '22023', message = 'REQUEST_UNKNOWN'; end if;
    perform pos_private.require_manager(subject,(body->>'organizationId')::uuid,(body->>'festivalId')::uuid);
    if r.consumed_at is not null or r.expires_at <= clock_timestamp() then
      raise exception using errcode = '22023', message = 'REQUEST_EXPIRED'; end if;
    target := (body->>'chainId')::uuid;
    if target is null then raise exception using errcode = '22023', message = 'CHAIN_REQUIRED'; end if;
    select * into c from pos_private.chains where chain_id = target for update;
    if found and (c.organization_id <> (body->>'organizationId')::uuid or c.festival_id <> (body->>'festivalId')::uuid) then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED'; end if;
    -- A matching prefix cannot be assigned to a new chain to bypass replacement.
    if not found and exists (
      select 1 from pos_private.ledger_events e where e.sequence = 1
        and e.hash = r.dossier#>>'{prefix,0,hash}'
    ) then raise exception using errcode = '22023', message = 'EXISTING_CHAIN_REQUIRED'; end if;
    if c.chain_id is null and (r.dossier->>'restored')::boolean then
      raise exception using errcode = '22023', message = 'RESTORE_MAPPING_REQUIRED'; end if;
    if c.chain_id is not null and exists (select 1 from pos_private.installations where chain_id = target and active) then
      if nullif(body->>'replacesInstallationId','')::uuid is distinct from
        (select installation_id from pos_private.installations where chain_id = target and active) then
        raise exception using errcode = '22023', message = 'REPLACEMENT_CONFIRMATION_REQUIRED'; end if;
    end if;
    update pos_private.enrollment_requests set organization_id = (body->>'organizationId')::uuid,
      festival_id = (body->>'festivalId')::uuid, chain_id = target, approved_by = subject,
      invitation_hash = body->>'invitationHash', invitation_expires_at = clock_timestamp() + interval '10 minutes',
      replaces_installation_id = nullif(body->>'replacesInstallationId','')::uuid
      where request_id = r.request_id;
    insert into pos_private.enrollment_audit(auth_subject,request_id,action) values(subject,r.request_id,'approved');
    return jsonb_build_object('status','pending','requestId',r.request_id);
  elsif action = 'revoke' then
    target := (body->>'chainId')::uuid;
    select * into c from pos_private.chains where chain_id = target for update;
    if not found then raise exception using errcode = '42501', message = 'SCOPE_DENIED'; end if;
    perform pos_private.require_manager(subject,c.organization_id,c.festival_id);
    if not exists (select 1 from pos_private.installations where chain_id = target and installation_id = (body->>'installationId')::uuid) then
      raise exception using errcode = '42501', message = 'INSTALLATION_DENIED'; end if;
    update pos_private.installations set active = false, revoked_at = clock_timestamp()
      where chain_id = target and installation_id = (body->>'installationId')::uuid and active;
    insert into pos_private.enrollment_audit(auth_subject,action) values(subject,'revoked');
    return jsonb_build_object('status','revoked');
  end if;

  update pos_private.auth_challenges ch set expires_at = '-infinity' where ch.auth_subject = subject and ch.nonce = proof_nonce
    and ch.installation_id = (body->>'installationId')::uuid and ch.expires_at > clock_timestamp();
  if not found then raise exception using errcode = '42501', message = 'PROOF_REQUIRED'; end if;
  select * into r from pos_private.enrollment_requests where auth_subject = subject
    and installation_id = (body->>'installationId')::uuid for update;
  if not found then raise exception using errcode = '42501', message = 'INSTALLATION_DENIED'; end if;
  if action = 'activate' then
    if r.consumed_at is not null then return jsonb_build_object('status','invitation_used'); end if;
    if r.expires_at <= clock_timestamp() then return jsonb_build_object('status','needs_recovery'); end if;
    if r.invitation_expires_at is null or r.invitation_expires_at <= clock_timestamp() then
      return jsonb_build_object('status','invitation_expired'); end if;
    if r.attempts >= 5 then return jsonb_build_object('status','attempts_exceeded'); end if;
    update pos_private.enrollment_requests set attempts = attempts + 1 where request_id = r.request_id;
    if r.invitation_hash is distinct from body->>'invitationHash' then
      return jsonb_build_object('status','invitation_invalid'); end if;
    -- Recheck the approver's live authority, not the metadata of the tablet.
    perform pos_private.require_manager(r.approved_by,r.organization_id,r.festival_id);
    insert into pos_private.chains(organization_id,festival_id,chain_id)
      values(r.organization_id,r.festival_id,r.chain_id) on conflict (chain_id) do nothing;
    select * into c from pos_private.chains where chain_id = r.chain_id for update;
    if c.organization_id <> r.organization_id or c.festival_id <> r.festival_id then
      raise exception using errcode = '42501', message = 'SCOPE_DENIED'; end if;
    select * into i from pos_private.installations where chain_id = c.chain_id and active;
    if i.installation_id is not null and i.installation_id is distinct from r.replaces_installation_id then
      return jsonb_build_object('status','replacement_conflict'); end if;
    if i.installation_id is not null then
      update pos_private.installations set active = false, revoked_at = clock_timestamp() where installation_id = i.installation_id;
    end if;
    if exists (select 1 from pos_private.installations where chain_id = c.chain_id) then
      update pos_private.chains set enrollment_generation = enrollment_generation + 1 where chain_id = c.chain_id
        returning * into c;
    end if;
    prefix := r.dossier->'prefix';
    recovery := c.head_sequence > jsonb_array_length(prefix) or exists (
      select 1 from pos_private.ledger_events e where e.chain_id = c.chain_id and not exists (
        select 1 from jsonb_array_elements(prefix) p where (p->>'sequence')::bigint = e.sequence
          and p->>'hash' = e.hash and p->>'eventId' = e.event_id and p->>'terminalId' = e.source_terminal_id
      )
    );
    -- Fresh chain: record approved historical ranges without rewriting any payload.
    if not exists (select 1 from pos_private.terminal_ranges where chain_id = c.chain_id) then
      first_seq := 1; last_terminal := null;
      for item in select value from jsonb_array_elements(prefix) loop
        if last_terminal is not null and last_terminal <> item->>'terminalId' then
          insert into pos_private.terminal_ranges values(c.organization_id,c.festival_id,c.chain_id,first_seq,(item->>'sequence')::bigint-1,last_terminal,r.request_id::text);
          first_seq := (item->>'sequence')::bigint;
        end if;
        last_terminal := item->>'terminalId';
      end loop;
      if last_terminal is not null and last_terminal <> r.dossier->>'terminalId' then
        insert into pos_private.terminal_ranges values(c.organization_id,c.festival_id,c.chain_id,first_seq,jsonb_array_length(prefix),last_terminal,r.request_id::text);
        first_seq := jsonb_array_length(prefix) + 1;
      end if;
      insert into pos_private.terminal_ranges values(c.organization_id,c.festival_id,c.chain_id,first_seq,null,r.dossier->>'terminalId',r.request_id::text);
    else
      recovery := recovery or not exists (
        select 1 from pos_private.terminal_ranges t where t.chain_id = c.chain_id
          and t.terminal_id = r.dossier->>'terminalId' and t.last_sequence is null
      ) or exists (
        select 1 from jsonb_array_elements(prefix) p where not exists (
          select 1 from pos_private.terminal_ranges t where t.chain_id = c.chain_id and t.terminal_id = p->>'terminalId'
            and (p->>'sequence')::bigint >= t.first_sequence
            and (t.last_sequence is null or (p->>'sequence')::bigint <= t.last_sequence)
        )
      );
    end if;
    insert into pos_private.installations(installation_id,organization_id,festival_id,chain_id,auth_subject,enrollment_generation)
      values(r.installation_id,c.organization_id,c.festival_id,c.chain_id,subject,c.enrollment_generation);
    insert into pos_private.installation_keys values(r.installation_id,r.public_key,case when recovery then 'needs_recovery' else 'ready' end,r.request_id);
    update pos_private.enrollment_requests set consumed_at = clock_timestamp() where request_id = r.request_id;
    insert into pos_private.enrollment_audit(auth_subject,request_id,action) values(subject,r.request_id,case when recovery then 'recovery_required' else 'activated' end);
  elsif action <> 'status' and action <> 'authorize' then
    raise exception using errcode = '22023', message = 'ACTION_UNKNOWN';
  end if;
  select * into i from pos_private.installations where auth_subject = subject;
  if not found then return jsonb_build_object('status','pending','requestId',r.request_id); end if;
  select * into c from pos_private.chains where chain_id = i.chain_id for update;
  if not i.active or i.enrollment_generation <> c.enrollment_generation or not exists (
    select 1 from pos_private.organizations o join pos_private.festivals f using(organization_id)
      where o.organization_id = i.organization_id and f.festival_id = i.festival_id and o.active and f.active
  ) then return jsonb_build_object('status','revoked'); end if;
  if action = 'authorize' then perform pos_private.require_installation(subject,body); end if;
  select continuity_state = 'needs_recovery' into recovery from pos_private.installation_keys where installation_id = i.installation_id;
  return jsonb_build_object('status',case when recovery then 'needs_recovery' else 'authorized' end,
    'organizationId',i.organization_id,'festivalId',i.festival_id,'chainId',i.chain_id,
    'installationId',i.installation_id,'enrollmentGeneration',i.enrollment_generation,
    'serverHead',jsonb_build_object('sequence',c.head_sequence,'hash',c.head_hash));
end $$;

revoke all on function public.tablet_auth_v1(uuid,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.tablet_auth_v1(uuid,text,jsonb,uuid) to service_role;
grant execute on function pos_private.require_manager(uuid,uuid,uuid), pos_private.require_installation(uuid,jsonb) to pos_enrollment_executor;
revoke all on function pos_private.require_manager(uuid,uuid,uuid), pos_private.require_installation(uuid,jsonb) from public, anon, authenticated, service_role;
grant create on schema public to pos_enrollment_executor;
alter function public.tablet_auth_v1(uuid,text,jsonb,uuid) owner to pos_enrollment_executor;
revoke create on schema public from pos_enrollment_executor;

-- All installations require possession proof, including preexisting registry rows.
-- Manager/auditor RLS remains scoped by its existing live grants.
grant select on pos_private.installation_keys to pos_policy_reader;
create policy authorization_lookup on pos_private.installation_keys for select to pos_policy_reader using(true);
create function pos_private.direct_read_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from pos_private.installations i
    where i.auth_subject = coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
      nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
  );
$$;
grant create on schema pos_private to pos_policy_reader;
alter function pos_private.direct_read_allowed() owner to pos_policy_reader;
revoke create on schema pos_private from pos_policy_reader;
revoke all on function pos_private.direct_read_allowed() from public, anon, service_role;
grant execute on function pos_private.direct_read_allowed() to authenticated;
do $$ declare t text; begin
  foreach t in array array['chains','terminal_ranges','ledger_events','sales','sync_receipts'] loop
    execute format('create policy proof_required on pos_private.%I as restrictive for select to authenticated using (pos_private.direct_read_allowed())',t);
  end loop;
end $$;
