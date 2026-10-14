-- samhain-sync/1: server copies only. No client or service-role write path.
create schema pos_private;
revoke all on schema pos_private from public, anon, authenticated, service_role;
alter default privileges in schema pos_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema pos_private revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema pos_private revoke execute on functions from public, anon, authenticated, service_role;

create domain pos_private.opaque_id as text
  check (octet_length(value) between 1 and 512 and btrim(value) <> '');
create domain pos_private.sha256 as text check (value ~ '^[0-9a-f]{64}$');
create domain pos_private.safe_sequence as bigint check (value between 1 and 9007199254740991);

create table pos_private.organizations (
  organization_id uuid primary key,
  active boolean not null default true
);
create table pos_private.festivals (
  organization_id uuid not null references pos_private.organizations,
  festival_id uuid not null,
  active boolean not null default true,
  primary key (organization_id, festival_id)
);

-- The chain row is also its lockable head. Its scope never changes.
create table pos_private.chains (
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid primary key,
  enrollment_generation pos_private.safe_sequence not null default 1,
  head_sequence bigint not null default 0 check (head_sequence between 0 and 9007199254740991),
  head_hash pos_private.sha256,
  check ((head_sequence = 0) = (head_hash is null)),
  unique (organization_id, festival_id, chain_id),
  foreign key (organization_id, festival_id) references pos_private.festivals
);

create table pos_private.installations (
  installation_id uuid primary key,
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid not null,
  auth_subject uuid not null unique references auth.users(id),
  enrollment_generation pos_private.safe_sequence not null,
  active boolean not null default true,
  revoked_at timestamptz,
  check (active = (revoked_at is null)),
  unique (organization_id, festival_id, chain_id, installation_id, enrollment_generation, auth_subject),
  foreign key (organization_id, festival_id, chain_id) references pos_private.chains(organization_id, festival_id, chain_id)
);
create unique index installations_one_active_chain on pos_private.installations(chain_id) where active;

-- Capabilities are explicit; managing enrollment does not imply reading money.
create table pos_private.scope_grants (
  organization_id uuid not null,
  festival_id uuid not null,
  auth_subject uuid not null references auth.users(id),
  capability text not null check (capability in ('read_ledger', 'manage_enrollment')),
  active boolean not null default true,
  primary key (auth_subject, organization_id, festival_id, capability),
  foreign key (organization_id, festival_id) references pos_private.festivals
);

-- A terminal may recur in disjoint ranges. NULL end denotes an open range.
create table pos_private.terminal_ranges (
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid not null,
  first_sequence pos_private.safe_sequence not null,
  last_sequence pos_private.safe_sequence,
  terminal_id pos_private.opaque_id not null,
  evidence_reference text not null check (btrim(evidence_reference) <> ''),
  check (last_sequence is null or last_sequence >= first_sequence),
  primary key (organization_id, festival_id, chain_id, first_sequence),
  foreign key (organization_id, festival_id, chain_id) references pos_private.chains(organization_id, festival_id, chain_id)
);

create table pos_private.ledger_events (
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid not null,
  event_id pos_private.opaque_id not null,
  sequence pos_private.safe_sequence not null,
  schema_version integer not null check (schema_version = 1),
  kind text not null check (kind in ('sale', 'correction', 'closure', 'cash_session_opened', 'cash_float_updated')),
  recorded_at text not null check (recorded_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$'),
  previous_hash pos_private.sha256,
  hash pos_private.sha256 not null,
  source_terminal_id pos_private.opaque_id not null,
  protocol_version integer not null check (protocol_version = 1),
  ledger_canonicalization text not null check (ledger_canonicalization in ('ts-ledger-v1', 'android-ledger-v1')),
  payload_canonical text not null check (octet_length(payload_canonical) between 1 and 262144),
  payload jsonb generated always as (payload_canonical::jsonb) stored,
  transport_fingerprint pos_private.sha256 not null,
  order_id pos_private.opaque_id generated always as (
    case when kind = 'sale' then payload_canonical::jsonb ->> 'orderId' end
  ) stored,
  operation_id pos_private.opaque_id generated always as (
    case kind
      when 'correction' then payload_canonical::jsonb #>> '{correction,operationId}'
      when 'closure' then payload_canonical::jsonb #>> '{closure,operationId}'
      when 'cash_float_updated' then payload_canonical::jsonb #>> '{cashFloatUpdate,operationId}'
    end
  ) stored,
  session_id pos_private.opaque_id generated always as (
    case when kind = 'cash_session_opened' then payload_canonical::jsonb #>> '{session,sessionId}' end
  ) stored,
  original_order_id pos_private.opaque_id generated always as (
    case when kind = 'correction' then payload_canonical::jsonb #>> '{correction,originalOrderId}' end
  ) stored,
  original_sale_hash pos_private.sha256 generated always as (
    case when kind = 'correction' then payload_canonical::jsonb #>> '{correction,originalSaleHash}' end
  ) stored,
  referenced_session_id pos_private.opaque_id generated always as (
    case kind
      when 'cash_float_updated' then payload_canonical::jsonb #>> '{cashFloatUpdate,sessionId}'
      when 'closure' then payload_canonical::jsonb #>> '{closure,cashSessionId}'
    end
  ) stored,
  primary key (organization_id, festival_id, chain_id, event_id),
  unique (organization_id, festival_id, chain_id, sequence),
  unique (organization_id, festival_id, chain_id, sequence, hash),
  unique (organization_id, festival_id, chain_id, kind, operation_id),
  unique (organization_id, festival_id, chain_id, session_id),
  unique (organization_id, festival_id, chain_id, event_id, order_id, hash),
  foreign key (organization_id, festival_id, chain_id) references pos_private.chains(organization_id, festival_id, chain_id),
  foreign key (organization_id, festival_id, chain_id, referenced_session_id) references pos_private.ledger_events(organization_id, festival_id, chain_id, session_id),
  check ((sequence = 1) = (previous_hash is null)),
  check (payload @> jsonb_build_object(
    'id', event_id, 'sequence', sequence, 'schemaVersion', schema_version,
    'kind', kind, 'recordedAt', recorded_at, 'previousHash', previous_hash, 'hash', hash
  )),
  check ((jsonb_typeof(payload -> 'source') = 'object' and
    payload #> '{source,terminal,terminalId}' = to_jsonb(source_terminal_id)) is true),
  check (((kind <> 'sale') or (order_id is not null and
    payload #> '{order,id}' = to_jsonb(order_id) and jsonb_typeof(payload -> 'order') = 'object' and
    not (payload -> 'order' ?| array['printing', 'integrity']))) is true),
  check ((kind not in ('correction', 'closure', 'cash_float_updated')) or operation_id is not null),
  check ((kind <> 'correction') or (original_order_id is not null and payload -> 'correction' ? 'originalSaleHash')),
  check ((kind <> 'cash_session_opened') or session_id is not null),
  check ((kind <> 'cash_float_updated') or referenced_session_id is not null)
);

-- An identity projection prevents counting a restored order in another chain.
-- Sealed snapshots live only in ledger_events; legacy snapshots live here.
create table pos_private.sales (
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid not null,
  order_id pos_private.opaque_id not null,
  ledger_event_id pos_private.opaque_id,
  sale_hash pos_private.sha256,
  legacy_payload_canonical text check (octet_length(legacy_payload_canonical) between 1 and 262144),
  legacy_payload jsonb generated always as (legacy_payload_canonical::jsonb) stored,
  legacy_transport_fingerprint pos_private.sha256,
  legacy_protocol_version integer check (legacy_protocol_version = 1),
  primary key (organization_id, festival_id, order_id),
  unique (organization_id, festival_id, chain_id, order_id),
  check ((ledger_event_id is not null and sale_hash is not null and
    legacy_payload_canonical is null and legacy_transport_fingerprint is null and legacy_protocol_version is null)
    or (ledger_event_id is null and sale_hash is null and legacy_payload_canonical is not null and
    legacy_transport_fingerprint is not null and legacy_protocol_version is not null)),
  check ((legacy_payload_canonical is null or (jsonb_typeof(legacy_payload) = 'object' and
    legacy_payload -> 'id' = to_jsonb(order_id) and not (legacy_payload ?| array['printing', 'integrity']))) is true),
  foreign key (organization_id, festival_id, chain_id) references pos_private.chains(organization_id, festival_id, chain_id),
  foreign key (organization_id, festival_id, chain_id, ledger_event_id, order_id, sale_hash)
    references pos_private.ledger_events(organization_id, festival_id, chain_id, event_id, order_id, hash)
);
alter table pos_private.ledger_events add constraint correction_sale_fk
  foreign key (organization_id, festival_id, chain_id, original_order_id)
  references pos_private.sales(organization_id, festival_id, chain_id, order_id);
alter table pos_private.chains add constraint chain_head_fk
  foreign key (organization_id, festival_id, chain_id, head_sequence, head_hash)
  references pos_private.ledger_events(organization_id, festival_id, chain_id, sequence, hash)
  deferrable initially deferred;

-- Server metadata never becomes a field in the original financial payload.
create table pos_private.sync_receipts (
  receipt_id uuid not null default gen_random_uuid() unique,
  organization_id uuid not null,
  festival_id uuid not null,
  chain_id uuid not null,
  event_type text not null check (event_type in ('ledger', 'legacy_order')),
  event_id pos_private.opaque_id not null,
  ledger_event_id pos_private.opaque_id,
  legacy_order_id pos_private.opaque_id,
  installation_id uuid not null,
  enrollment_generation pos_private.safe_sequence not null,
  auth_subject uuid not null references auth.users(id),
  first_request_id uuid not null,
  server_received_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, festival_id, chain_id, event_type, event_id),
  check ((event_type = 'ledger' and ledger_event_id = event_id and ledger_event_id is not null and legacy_order_id is null)
    or (event_type = 'legacy_order' and legacy_order_id = event_id and legacy_order_id is not null and ledger_event_id is null)),
  foreign key (organization_id, festival_id, chain_id, ledger_event_id)
    references pos_private.ledger_events(organization_id, festival_id, chain_id, event_id),
  foreign key (organization_id, festival_id, chain_id, legacy_order_id)
    references pos_private.sales(organization_id, festival_id, chain_id, order_id),
  foreign key (organization_id, festival_id, chain_id, installation_id, enrollment_generation, auth_subject)
    references pos_private.installations(organization_id, festival_id, chain_id, installation_id, enrollment_generation, auth_subject)
);

-- Closed even between initial schema and the additive security migration.
do $$
declare t text;
begin
  foreach t in array array['organizations', 'festivals', 'chains', 'installations', 'scope_grants',
    'terminal_ranges', 'ledger_events', 'sales', 'sync_receipts'] loop
    execute format('alter table pos_private.%I enable row level security', t);
    execute format('alter table pos_private.%I force row level security', t);
  end loop;
end;
$$;
revoke all on all tables in schema pos_private from public, anon, authenticated, service_role;
revoke all on all functions in schema pos_private from public, anon, authenticated, service_role;
