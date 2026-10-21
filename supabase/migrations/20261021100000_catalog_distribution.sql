-- Catalogue transport is independent of financial ingestion and never rewrites snapshots.
alter table pos_private.scope_grants drop constraint scope_grants_capability_check;
alter table pos_private.scope_grants add constraint scope_grants_capability_check
  check (capability in ('read_ledger', 'manage_enrollment', 'publish_catalog'));

create table pos_private.catalog_heads (
  organization_id uuid not null,
  festival_id uuid not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  primary key (organization_id, festival_id),
  foreign key (organization_id, festival_id) references pos_private.festivals
);
create table pos_private.catalog_versions (
  version_id uuid primary key,
  organization_id uuid not null,
  festival_id uuid not null,
  revision pos_private.safe_sequence not null,
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null,
  payload text not null check (octet_length(payload) <= 450000),
  sha256 pos_private.sha256 not null,
  unique (organization_id, festival_id, revision),
  foreign key (organization_id, festival_id) references pos_private.festivals,
  check (sha256 = encode(extensions.digest(convert_to(payload, 'UTF8'), 'sha256'), 'hex'))
);
alter table pos_private.catalog_heads enable row level security;
alter table pos_private.catalog_heads force row level security;
alter table pos_private.catalog_versions enable row level security;
alter table pos_private.catalog_versions force row level security;
revoke all on pos_private.catalog_heads, pos_private.catalog_versions from public, anon, authenticated, service_role;

create function pos_private.guard_catalog_version() returns trigger
language plpgsql set search_path = '' as $$ begin
  raise exception 'Published catalogues are immutable';
end $$;
create trigger catalog_version_immutable before update or delete on pos_private.catalog_versions
  for each row execute function pos_private.guard_catalog_version();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'pos_catalog_executor') then
    create role pos_catalog_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pos_catalog_executor' and
    (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) or
    pg_has_role('anon','pos_catalog_executor','MEMBER') or pg_has_role('authenticated','pos_catalog_executor','MEMBER') or
    pg_has_role('service_role','pos_catalog_executor','MEMBER') then raise exception 'Unsafe catalog executor'; end if;
end $$;
grant pos_catalog_executor to postgres;
grant usage on schema pos_private to pos_catalog_executor;
grant usage on schema extensions to pos_catalog_executor;
grant select on pos_private.organizations, pos_private.festivals, pos_private.scope_grants,
  pos_private.installations, pos_private.installation_keys, pos_private.chains, pos_private.auth_challenges,
  pos_private.terminal_ranges, pos_private.catalog_heads, pos_private.catalog_versions to pos_catalog_executor;
grant insert, update on pos_private.catalog_heads to pos_catalog_executor;
grant insert on pos_private.catalog_versions to pos_catalog_executor;
grant update(expires_at) on pos_private.auth_challenges to pos_catalog_executor;
-- Row locks used by the existing live authorization helpers.
grant update(chain_id) on pos_private.chains to pos_catalog_executor;
grant update(organization_id) on pos_private.organizations, pos_private.festivals, pos_private.scope_grants to pos_catalog_executor;
grant execute on function pos_private.require_sync_session(uuid,uuid),
  pos_private.consume_installation_proof(uuid,jsonb,uuid), pos_private.require_installation(uuid,jsonb) to pos_catalog_executor;
do $$ declare t text; begin
  foreach t in array array['organizations','festivals','scope_grants','installations','installation_keys','chains',
    'auth_challenges','terminal_ranges','catalog_heads','catalog_versions'] loop
    execute format('create policy catalog_executor on pos_private.%I to pos_catalog_executor using(true) with check(true)',t);
  end loop;
end $$;

create function pos_private.require_catalog_account(subject uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
  if not exists (select 1 from auth.users where id = subject and not coalesce(is_anonymous,false)) then
    raise exception using errcode = '42501', message = 'PUBLISH_DENIED';
  end if;
end $$;
revoke all on function pos_private.require_catalog_account(uuid) from public,anon,authenticated,service_role;
grant execute on function pos_private.require_catalog_account(uuid) to pos_catalog_executor;

-- Only the Edge Function may call this RPC. Subject and live session come from verified Auth.
create function public.catalog_v1(subject uuid, session_id uuid, body jsonb, proof_nonce uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  organization uuid := (body->>'organizationId')::uuid;
  festival uuid := (body->>'festivalId')::uuid;
  head bigint;
  version uuid := gen_random_uuid();
  published timestamptz := clock_timestamp();
  document text;
  result jsonb;
  p jsonb;
  c jsonb;
begin
  perform pos_private.require_sync_session(subject, session_id);
  if body->>'action' = 'read' then
    perform pos_private.consume_installation_proof(subject,body,proof_nonce);
    select jsonb_build_object('payload',v.payload,'sha256',v.sha256) into result
      from pos_private.catalog_versions v where v.organization_id = organization and v.festival_id = festival
      order by v.revision desc limit 1;
    return jsonb_build_object('version',result,'organizationId',organization,'festivalId',festival);
  end if;
  if body->>'action' is distinct from 'publish' then raise exception 'ACTION_UNKNOWN'; end if;
  perform pos_private.require_catalog_account(subject);
  -- Enrollment administration and a local PIN confer no publication permission.
  if exists (select 1 from pos_private.installations where auth_subject = subject) then
    raise exception using errcode = '42501', message = 'PUBLISH_DENIED';
  end if;
  perform 1 from pos_private.scope_grants g
    join pos_private.organizations o using(organization_id)
    join pos_private.festivals f using(organization_id,festival_id)
    where g.auth_subject = subject and g.organization_id = organization and g.festival_id = festival
      and g.capability = 'publish_catalog' and g.active and o.active and f.active for share of g,o,f;
  if not found then raise exception using errcode = '42501', message = 'PUBLISH_DENIED'; end if;
  if jsonb_typeof(body->'products') is distinct from 'array' or jsonb_typeof(body->'categories') is distinct from 'array' or
    jsonb_array_length(body->'products') > 2000 or jsonb_array_length(body->'categories') > 200 or octet_length(body::text) > 450000 then
    raise exception 'INVALID_CATALOG';
  end if;
  if (select count(*) <> count(distinct x->>'id') from jsonb_array_elements(body->'products') x) or
     (select count(*) <> count(distinct x->>'id') from jsonb_array_elements(body->'categories') x) then raise exception 'INVALID_CATALOG'; end if;
  for c in select * from jsonb_array_elements(body->'categories') loop
    if coalesce(length(btrim(c->>'id')),0) = 0 or coalesce(length(btrim(c->>'label')),0) = 0 or
      jsonb_typeof(c->'active') is distinct from 'boolean' or coalesce(c->>'displayOrder','') !~ '^[0-9]+$' then raise exception 'INVALID_CATALOG'; end if;
  end loop;
  for p in select * from jsonb_array_elements(body->'products') loop
    if coalesce(length(btrim(p->>'id')),0) = 0 or coalesce(length(btrim(p->>'name')),0) = 0 or
      p->>'dataConfidence' is distinct from 'confirmed' or coalesce(p->>'vatRate','') not in ('10','20') or
      coalesce(p->>'availability','') not in ('available','sold-out') or jsonb_typeof(p->'active') is distinct from 'boolean' or
      jsonb_typeof(p->'requiresPreparation') is distinct from 'boolean' or coalesce(p->>'displayOrder','') !~ '^[0-9]+$' or
      not exists(select 1 from jsonb_array_elements(body->'categories') x where x->>'id' = p->>'categoryId') then raise exception 'INVALID_CATALOG'; end if;
    if p ? 'priceCents' and (coalesce(p->>'priceCents','') !~ '^[0-9]+$' or (p->>'priceCents')::numeric > 9007199254740991) then raise exception 'INVALID_CATALOG'; end if;
    if not (p ? 'priceCents') and (jsonb_typeof(p->'variants') is distinct from 'array' or jsonb_array_length(p->'variants') = 0) then raise exception 'INVALID_CATALOG'; end if;
  end loop;
  insert into pos_private.catalog_heads(organization_id,festival_id) values(organization,festival) on conflict do nothing;
  select revision into head from pos_private.catalog_heads where organization_id = organization and festival_id = festival for update;
  if jsonb_typeof(body->'expectedRevision') is distinct from 'number' or head::text is distinct from body->>'expectedRevision' then
    raise exception using errcode = '40001', message = 'CATALOG_HEAD_MOVED';
  end if;
  document := jsonb_build_object('id',version,'revision',head+1,'schemaVersion',1,'publishedAt',published,
    'organizationId',organization,'festivalId',festival,'origin','supabase:' || subject::text,
    'products',body->'products','categories',body->'categories')::text;
  insert into pos_private.catalog_versions values(version,organization,festival,head+1,subject,published,document,
    encode(extensions.digest(convert_to(document,'UTF8'),'sha256'),'hex'));
  update pos_private.catalog_heads set revision = head+1 where organization_id = organization and festival_id = festival;
  return jsonb_build_object('version',jsonb_build_object('payload',document,'sha256',encode(extensions.digest(convert_to(document,'UTF8'),'sha256'),'hex')));
end $$;
revoke all on function pos_private.guard_catalog_version() from public,anon,authenticated,service_role;
revoke all on function public.catalog_v1(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.catalog_v1(uuid,uuid,jsonb,uuid) to service_role;
grant create on schema public to pos_catalog_executor;
alter function public.catalog_v1(uuid,uuid,jsonb,uuid) owner to pos_catalog_executor;
revoke create on schema public from pos_catalog_executor;
