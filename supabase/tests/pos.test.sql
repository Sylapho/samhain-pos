begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();
\ir fixtures/pos.psql

-- Inventory checks exercise every table and function, including private ones.
select ok(c.relrowsecurity and c.relforcerowsecurity, c.relname || ': RLS enabled and forced')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'pos_private' and c.relkind = 'r' order by c.relname;
select ok(not has_table_privilege(role_name, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  role_name || ': no mutation grant on ' || c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['anon', 'authenticated', 'service_role', 'pos_policy_reader']) role_name
  where n.nspname = 'pos_private' and c.relkind = 'r' order by c.relname, role_name;
select ok(not has_table_privilege('anon', c.oid, 'SELECT') and not has_table_privilege('service_role', c.oid, 'SELECT') and
  has_table_privilege('authenticated', c.oid, 'SELECT') = (c.relname in ('chains', 'terminal_ranges', 'ledger_events', 'sales', 'sync_receipts')),
  c.relname || ': minimal SELECT grants')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'pos_private' and c.relkind = 'r' order by c.relname;
select ok(not has_function_privilege('anon', p.oid, 'EXECUTE') and
  not has_function_privilege('service_role', p.oid, 'EXECUTE') and
  has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname in ('can_read_chain','direct_read_allowed')),
  p.proname || ': minimal EXECUTE grants')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pos_private' order by p.proname;
select ok(p.proconfig @> array['search_path=""'], p.proname || ': locked search_path')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pos_private' order by p.proname;
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pos_private' and p.prosecdef and p.proname <> 'require_sync_session'), 2::bigint, 'Only bounded read helpers besides the closed Auth check are definers');
select ok(not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls and not rolcreaterole,
  'Policy helper owner cannot log in or bypass RLS') from pg_roles where rolname = 'pos_policy_reader';
select ok(not pg_has_role('authenticated', 'pos_policy_reader', 'MEMBER') and
  not pg_has_role('anon', 'pos_policy_reader', 'MEMBER') and not pg_has_role('service_role', 'pos_policy_reader', 'MEMBER'),
  'API roles cannot assume the policy helper owner');
select ok(not has_schema_privilege('authenticated', 'pos_private', 'CREATE') and
  not has_schema_privilege('pos_policy_reader', 'pos_private', 'CREATE') and
  not has_schema_privilege('anon', 'pos_private', 'USAGE'), 'Private schema cannot be extended by clients');
select is((select count(*) from pg_views where schemaname in ('public', 'pos_private')
  and definition ilike '%pos_private%'), 0::bigint, 'No view exposes private data or bypasses RLS');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ilike '%pos_private%' and
    (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))), 0::bigint, 'No client-callable public ingestion RPC');
select is((select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pos_private' and p.polcmd <> 'r'
    and p.polname not in ('enrollment_executor','ledger_executor')),
  0::bigint, 'No client write policy');
select ok(not has_table_privilege('authenticated', c.oid, 'SELECT'), c.relname || ': registry not readable directly')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'pos_private' and c.relname in ('organizations', 'festivals', 'installations', 'scope_grants');
select ok(exists (select 1 from pg_constraint where conrelid = 'pos_private.ledger_events'::regclass and contype = 'u'
  and pg_get_constraintdef(oid) = definition), 'Ledger uniqueness: ' || definition)
  from unnest(array[
    'UNIQUE (organization_id, festival_id, chain_id, sequence)',
    'UNIQUE (organization_id, festival_id, chain_id, kind, operation_id)',
    'UNIQUE (organization_id, festival_id, chain_id, session_id)'
  ]) definition;
select ok(exists (select 1 from pg_index where indrelid = 'pos_private.installations'::regclass and indisunique
  and indexrelid = to_regclass('pos_private.' || name)), 'Active installation index: ' || name)
  from unnest(array['installations_one_active_chain']) name;
select ok(exists (select 1 from pg_constraint where conrelid = 'pos_private.installations'::regclass
  and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (auth_subject)'), 'Auth subject belongs permanently to one installation');
select ok(condeferrable and condeferred, 'Head FK is checked at transaction commit') from pg_constraint
  where conrelid = 'pos_private.chains'::regclass and conname = 'chain_head_fk';

set local role anon;
select throws_ok('select * from pos_private.ledger_events', '42501', null, 'Anonymous financial read denied');
select throws_ok('select pos_private.can_read_chain(null, null, null)', '42501', null, 'Anonymous helper call denied');
reset role;

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is((select count(*) from pos_private.chains), 0::bigint, 'A must use possession proof for chain reads');
select is((select count(*) from pos_private.terminal_ranges), 0::bigint, 'A must use possession proof for mappings');
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'A cannot bypass proof for financial reads');
select is((select count(*) from pos_private.sales), 0::bigint, 'A must use possession proof for sales');
select is((select count(*) from pos_private.sync_receipts), 0::bigint, 'A must use possession proof for receipts');
select is((select count(*) from pos_private.ledger_events where chain_id <> pg_temp.chain_id(1)),
  0::bigint, 'A cannot read B, another festival, or another organization');
select throws_ok('select * from pos_private.installations', '42501', null, 'A cannot read enrollment secrets/identities');
select throws_ok('select * from pos_private.scope_grants', '42501', null, 'A cannot inspect grants');
select throws_ok('select pos_private.guard_append()', '42501', null, 'A cannot call a privileged trigger function directly');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'forbidden', 'closure', '{"closure":{"operationId":"forbidden"}}')$$,
  '42501', null, 'A cannot insert directly, even in its own chain');
select throws_ok('update pos_private.ledger_events set hash = hash', '42501', null, 'A cannot update financial events');
select throws_ok('delete from pos_private.ledger_events', '42501', null, 'A cannot delete financial events');
reset role;

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000002', true);
-- Forged application metadata is not an authorization source.
select set_config('request.jwt.claims', '{"sub":"30000000-0000-0000-0000-000000000002","user_metadata":{"terminalId":"terminal:1","organizationId":"00000000-0000-0000-0000-000000000001","capability":"read_ledger"}}', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'B cannot bypass proof with forged terminal metadata');
select is((select count(*) from pos_private.ledger_events where chain_id = pg_temp.chain_id(1)), 0::bigint, 'B cannot read A');
select throws_ok('update pos_private.chains set enrollment_generation = enrollment_generation + 1',
  '42501', null, 'B cannot grant itself a chain');
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'JWT claims fallback cannot bypass proof');
reset role;
select set_config('request.jwt.claims', '{}', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Authenticated role without a verified subject reads nothing');
reset role;

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 7::bigint, 'Explicit reader sees A+B within assigned festival');
select is((select count(*) from pos_private.sales), 3::bigint, 'Reader sales remain scoped');
select is((select count(*) from pos_private.sync_receipts), 8::bigint, 'Reader receipts remain scoped');
select throws_ok('delete from pos_private.sales', '42501', null, 'Reader cannot mutate a sale');
reset role;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000004', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Enrollment manager has no implicit financial read');
reset role;
insert into pos_private.scope_grants values ('00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', 'read_ledger', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 7::bigint, 'Manager with explicit read capability is festival-scoped');
reset role;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events where chain_id = pg_temp.chain_id(1)), 0::bigint, 'Out-of-scope manager cannot read A');
select is((select count(*) from pos_private.ledger_events), 1::bigint, 'Other organization reader sees only its assignment');
reset role;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000007', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Unassigned authenticated user reads nothing');
reset role;
set local role service_role;
select throws_ok('select * from pos_private.ledger_events', '42501', null, 'Service role BYPASSRLS still has no financial grant');
select throws_ok('select pos_private.guard_append()', '42501', null, 'Service role has no unvalidated function path');
reset role;

-- Validate registry revocation with the original subject still in the session.
update pos_private.installations set active = false, revoked_at = '2026-10-14T09:00:00Z' where chain_id = pg_temp.chain_id(1);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Retired A loses access without changing its token subject');
select throws_ok('select pg_temp.add_receipt(pg_temp.chain_id(1), ''new'')', '42501', null, 'Retired A cannot create a receipt');
reset role;
insert into pos_private.scope_grants values ('00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'read_ledger', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Human capability cannot resurrect a retired installation subject');
reset role;
select throws_ok($$update pos_private.installations set active = true, revoked_at = null where chain_id = pg_temp.chain_id(1)$$,
  '55000', null, 'Retired enrollment cannot be reactivated');
update pos_private.chains set enrollment_generation = 2 where chain_id = pg_temp.chain_id(1);
select throws_ok($$insert into pos_private.installations(installation_id, organization_id, festival_id, chain_id, auth_subject, enrollment_generation)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), '30000000-0000-0000-0000-000000000007', 1)$$,
  '23514', null, 'Old generation cannot enroll a replacement');
select throws_ok($$insert into pos_private.installations(installation_id, organization_id, festival_id, chain_id, auth_subject, enrollment_generation)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), '30000000-0000-0000-0000-000000000001', 2)$$,
  '23505', null, 'Replacement cannot reuse retired Auth subject and revive old JWT rights');
insert into pos_private.installations(installation_id, organization_id, festival_id, chain_id, auth_subject, enrollment_generation)
  values ('40000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), '30000000-0000-0000-0000-000000000007', 2);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000007', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Replacement also requires possession proof for history');
reset role;
select throws_ok($$update pos_private.chains set enrollment_generation = 3 where chain_id = pg_temp.chain_id(1)$$,
  '23514', null, 'Generation cannot advance while an installation is active');
select throws_ok($$insert into pos_private.installations(installation_id, organization_id, festival_id, chain_id, auth_subject, enrollment_generation)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), '30000000-0000-0000-0000-000000000001', 2)$$,
  '23505', null, 'Two active installations cannot extend the same chain');

-- Disabling a festival, organization or capability immediately removes reads.
update pos_private.festivals set active = false where festival_id = '10000000-0000-0000-0000-000000000001';
set local role authenticated;
select is((select count(*) from pos_private.chains), 0::bigint, 'Disabled festival refuses replacement');
reset role;
update pos_private.festivals set active = true where festival_id = '10000000-0000-0000-0000-000000000001';
update pos_private.organizations set active = false where organization_id = '00000000-0000-0000-0000-000000000001';
set local role authenticated;
select is((select count(*) from pos_private.sync_receipts), 0::bigint, 'Disabled organization refuses receipts read');
reset role;
update pos_private.organizations set active = true where organization_id = '00000000-0000-0000-0000-000000000001';
update pos_private.scope_grants set active = false where auth_subject = '30000000-0000-0000-0000-000000000003';
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', true);
set local role authenticated;
select is((select count(*) from pos_private.ledger_events), 0::bigint, 'Revoked reader capability has no access');
reset role;

-- Invariant checks run as the migration owner, so RLS is not their protection.
select is((select count(distinct kind) from pos_private.ledger_events), 5::bigint, 'All five event kinds retained');
select is((select count(*) from pos_private.ledger_events where kind = 'sale' and payload #>> '{order,orderNumber}' = 'A-0001'
  and chain_id in (pg_temp.chain_id(1),pg_temp.chain_id(2),pg_temp.chain_id(3),pg_temp.chain_id(4))),
  4::bigint, 'Local ticket numbers can repeat across chains');
select ok((select not (payload -> 'correction' ? 'refundLines') from pos_private.ledger_events where event_id = 'correction:refund-A'),
  'Historical correction stays without refundLines');
select ok((select not (payload -> 'closure' ? 'cashSessionId') from pos_private.ledger_events where event_id = 'closure:close-A'),
  'Historical closure stays without cash session');
select ok((select sale_hash is null and ledger_event_id is null from pos_private.sales where order_id = 'legacy-A'),
  'Legacy sale has no fabricated hash or ledger ID');
select ok((select payload #> '{correction,originalSaleHash}' = 'null'::jsonb from pos_private.ledger_events where event_id = 'correction:legacy-refund-A'),
  'Legacy correction retains explicit null sale hash');
select is((select hash::text from pos_private.ledger_events where event_id = 'sale:order-A'), md5('sale:order-A') || md5('sale:order-A'), 'Original hash unchanged');
select ok((select payload = payload_canonical::jsonb and not (payload ? 'serverReceivedAt') from pos_private.ledger_events where event_id = 'sale:order-A'),
  'JSON projection matches original; receipt metadata is separate');

select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'sale:order-A', 'closure', '{"closure":{"operationId":"different"}}')$$,
  '23505', null, 'Reused event ID with divergent content refused');
select throws_ok($$insert into pos_private.ledger_events(organization_id, festival_id, chain_id, event_id, sequence, schema_version,
  kind, recorded_at, previous_hash, hash, source_terminal_id, protocol_version, ledger_canonicalization, payload_canonical, transport_fingerprint)
  select organization_id, festival_id, chain_id, event_id, sequence, schema_version, kind, recorded_at,
    previous_hash, hash, source_terminal_id, protocol_version, ledger_canonicalization, payload_canonical, transport_fingerprint
  from pos_private.ledger_events where event_id = 'sale:order-A'$$, '23505', null, 'Exact direct duplicate refused; ACK replay belongs to #36');
select throws_ok($$insert into pos_private.ledger_events(organization_id, festival_id, chain_id, event_id, sequence, schema_version,
  kind, recorded_at, previous_hash, hash, source_terminal_id, protocol_version, ledger_canonicalization, payload_canonical, transport_fingerprint)
  select organization_id, festival_id, chain_id, 'different-event', sequence, schema_version, kind, recorded_at,
    previous_hash, hash, source_terminal_id, protocol_version, ledger_canonicalization, payload_canonical, transport_fingerprint
  from pos_private.ledger_events where event_id = 'sale:order-A'$$, '23505', null, 'Another event cannot occupy an existing sequence');
select throws_ok($$insert into pos_private.festivals(organization_id, festival_id)
  values ('00000000-0000-0000-0000-000000000099', gen_random_uuid())$$, '23503', null, 'Festival requires an existing organization');
select throws_ok($$insert into pos_private.chains(organization_id, festival_id, chain_id)
  values ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', gen_random_uuid())$$,
  '23503', null, 'Organization/festival composite FK rejects mixed scopes');
select throws_ok($$insert into pos_private.chains(organization_id, festival_id, chain_id, head_sequence, head_hash)
  values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', gen_random_uuid(), 100, repeat('a', 64))$$,
  '23514', null, 'New chain cannot start with a fabricated head');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'correction:new-id', 'correction',
  jsonb_build_object('correction', jsonb_build_object('operationId', 'refund-A', 'originalOrderId', 'order-A', 'originalSaleHash', md5('sale:order-A') || md5('sale:order-A'))))$$,
  '23505', null, 'Correction operation key cannot be reused');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'cash-session:duplicate', 'cash_session_opened', '{"session":{"sessionId":"session-A"}}')$$,
  '23505', null, 'Cash session key cannot be reused');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'closure:duplicate-operation', 'closure', '{"closure":{"operationId":"close-A"}}')$$,
  '23505', null, 'Closure operation key cannot be reused');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'cash-float-update:duplicate-operation', 'cash_float_updated', '{"cashFloatUpdate":{"operationId":"float-A","sessionId":"session-A"}}')$$,
  '23505', null, 'Cash float operation key cannot be reused');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'sale:duplicate-order', 'sale', '{"orderId":"order-A","order":{"id":"order-A"}}')$$,
  '23505', null, 'Sale identity cannot be reused with another event');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(2), 'sale:copied-order', 'sale', '{"orderId":"order-A","order":{"id":"order-A"}}')$$,
  '23505', null, 'Same order in another chain within scope refused');
select throws_ok($$insert into pos_private.sales(organization_id, festival_id, chain_id, order_id, legacy_payload_canonical, legacy_transport_fingerprint, legacy_protocol_version)
  values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(2), 'order-A', '{"id":"order-A"}', repeat('d', 64), 1)$$,
  '23505', null, 'Legacy import cannot duplicate a sealed order in another chain');
select throws_ok($$insert into pos_private.sales(organization_id, festival_id, chain_id, order_id, legacy_payload_canonical, legacy_transport_fingerprint, legacy_protocol_version)
  values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), 'missing-legacy-id', '{}', repeat('d', 64), 1)$$,
  '23514', null, 'Missing legacy JSON ID cannot bypass CHECK via SQL NULL');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'correction:other-chain', 'correction', '{"correction":{"operationId":"other-chain","originalOrderId":"order-B","originalSaleHash":null}}')$$,
  '23503', null, 'Correction cannot reference a sale in another chain');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'correction:wrong-hash', 'correction', '{"correction":{"operationId":"wrong-hash","originalOrderId":"order-A","originalSaleHash":null}}')$$,
  '23514', null, 'Sealed sale cannot be referenced with a null hash');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'cash-float-update:missing', 'cash_float_updated', '{"cashFloatUpdate":{"operationId":"missing","sessionId":"missing"}}')$$,
  '23503', null, 'Float update must reference an opening in the same chain');
select throws_ok($$insert into pos_private.sync_receipts(organization_id, festival_id, chain_id, event_type, event_id,
  ledger_event_id, installation_id, enrollment_generation, auth_subject, first_request_id)
  values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), 'ledger',
    'missing', 'missing', '40000000-0000-0000-0000-000000000007', 2, '30000000-0000-0000-0000-000000000007', gen_random_uuid())$$,
  '23503', null, 'Receipt cannot refer to an absent ledger event');
select throws_ok($$select pg_temp.add_receipt(pg_temp.chain_id(1), 'order-A', 'legacy_order')$$,
  '23514', null, 'Sealed order cannot receive a legacy receipt');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'unmapped', 'closure', '{"closure":{"operationId":"unmapped"}}', true, 'forged-terminal')$$,
  '23514', null, 'Unmapped historical terminal refused even for owner insert');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'unknown-profile', 'closure', '{"closure":{"operationId":"unknown-profile"}}', true, null, 'unknown')$$,
  '23514', null, 'Unknown canonicalization profile refused');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'bad-order', 'sale', '{"orderId":"bad-order","order":{}}')$$,
  '23514', null, 'Missing JSON order ID cannot bypass CHECK via SQL NULL');
select throws_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'bad-snapshot', 'sale', '{"orderId":"bad-snapshot","order":{"id":"bad-snapshot","printing":{}}}')$$,
  '23514', null, 'Technical printing fields cannot contaminate sealed snapshot');
select throws_ok($$select ' '::pos_private.opaque_id$$, '23514', null, 'Blank opaque ID refused');
select throws_ok($$select repeat('é', 257)::pos_private.opaque_id$$, '23514', null, 'Opaque ID bound is UTF-8 bytes');
select throws_ok($$select 0::pos_private.safe_sequence$$, '23514', null, 'Zero event sequence refused');
select throws_ok($$select 9007199254740992::pos_private.safe_sequence$$, '23514', null, 'Unsafe event sequence refused');
select throws_ok($$select repeat('A', 64)::pos_private.sha256$$, '23514', null, 'Hash must be lowercase hex');

select throws_ok('update pos_private.ledger_events set payload_canonical = payload_canonical', '55000', null, 'Owner cannot UPDATE ledger');
select throws_ok('delete from pos_private.ledger_events', '55000', null, 'Owner cannot DELETE ledger');
set constraints all immediate;
select throws_ok('truncate pos_private.ledger_events cascade', '55000', null, 'Owner cannot TRUNCATE financial tables');
set constraints all deferred;
select throws_ok('update pos_private.sales set sale_hash = sale_hash', '55000', null, 'Sale identity/legacy snapshot immutable');
select throws_ok('delete from pos_private.sync_receipts', '55000', null, 'Idempotence receipts cannot be deleted');
select throws_ok('update pos_private.sync_receipts set first_request_id = gen_random_uuid()', '55000', null, 'First ingestion metadata cannot be rewritten');
select throws_ok($$update pos_private.chains set head_sequence = 0, head_hash = null where chain_id = pg_temp.chain_id(1)$$,
  '23514', null, 'Head cannot regress');
select throws_ok($$update pos_private.chains set head_hash = repeat('a', 64) where chain_id = pg_temp.chain_id(1)$$,
  '23514', null, 'Head hash cannot change at the same sequence');
select throws_ok($$update pos_private.chains set festival_id = '10000000-0000-0000-0000-000000000002' where chain_id = pg_temp.chain_id(1)$$,
  '55000', null, 'Chain cannot be moved to another festival');

create function pg_temp.missing_receipt() returns void language plpgsql as $$
begin
  perform pg_temp.add_event(pg_temp.chain_id(1), 'sale:no-receipt', 'sale', '{"orderId":"no-receipt","order":{"id":"no-receipt"}}', false);
  set constraints all immediate;
end;
$$;
select throws_ok('select pg_temp.missing_receipt()', '23514', null, 'Commit without a durable receipt refused');
select is((select head_sequence from pos_private.chains where chain_id = pg_temp.chain_id(1)), 6::bigint, 'Missing receipt rollback retains head');
select is((select count(*) from pos_private.sales where order_id = 'no-receipt'), 0::bigint, 'Missing receipt leaves no sale projection');
create function pg_temp.failed_batch() returns void language plpgsql as $$
begin
  perform pg_temp.add_event(pg_temp.chain_id(1), 'sale:rollback', 'sale', '{"orderId":"rollback","order":{"id":"rollback"}}');
  perform pg_temp.add_event(pg_temp.chain_id(1), 'correction:rollback', 'correction', '{"correction":{"operationId":"rollback","originalOrderId":"missing","originalSaleHash":null}}');
end;
$$;
select throws_ok('select pg_temp.failed_batch()', '23503', null, 'Failure midway rolls back the whole SQL transaction block');
select is((select count(*) from pos_private.ledger_events where event_id = 'sale:rollback'), 0::bigint, 'Failed batch retains no new event');
select is((select count(*) from pos_private.sync_receipts where event_id = 'sale:rollback'), 0::bigint, 'Failed batch retains no new receipt');
select is((select count(*) from pos_private.sales where order_id = 'rollback'), 0::bigint, 'Failed batch retains no new sale');
select is((select head_sequence from pos_private.chains where chain_id = pg_temp.chain_id(1)), 6::bigint, 'Failed batch does not advance head');

select throws_ok($$update pos_private.terminal_ranges set last_sequence = 5 where chain_id = pg_temp.chain_id(1)$$,
  '23514', null, 'Cannot close mapping before an already stored event');
update pos_private.terminal_ranges set last_sequence = 6 where chain_id = pg_temp.chain_id(1);
insert into pos_private.terminal_ranges values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), 7, 7, 'terminal:changed', 'fixture replacement');
select lives_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'closure:changed', 'closure', '{"closure":{"operationId":"changed"}}', true, 'terminal:changed')$$,
  'Same chain accepts a mapped second historical terminal');
insert into pos_private.terminal_ranges values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), 8, null, 'terminal:1', 'fixture recurrence');
select lives_ok($$select pg_temp.add_event(pg_temp.chain_id(1), 'closure:recurrence', 'closure', '{"closure":{"operationId":"recurrence"}}')$$,
  'Original terminal may recur in a disjoint range');
select throws_ok($$insert into pos_private.terminal_ranges values ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1), 9, null, 'terminal:overlap', 'fixture')$$,
  '23514', null, 'Overlapping historical mapping refused');
select is((select source_terminal_id::text from pos_private.ledger_events where sequence = 2 and chain_id = pg_temp.chain_id(1)),
  'terminal:1', 'Replacement never changes historical source');
-- Preserve literal UTF-8, whitespace and escaping without a JSONB round trip.
create temp table exact_payload as select
  '{"closure":{"operationId":"bytes"},"hash":"' || repeat('b', 64) ||
  '","id":"closure:bytes","kind":"closure","previousHash":"' || md5('closure:recurrence') || md5('closure:recurrence') ||
  '","recordedAt":"2026-10-14T08:00:00.000000001Z","schemaVersion":1,"sequence":9,"source":{"buildMode":"test","organization":{"eventName":"Fixture é 🍂"},"softwareVersion":"fixture\\path\n","terminal":{"displayName":"Fixture","terminalCode":"A","terminalId":"terminal:1"}}}' as original;
insert into pos_private.ledger_events(organization_id, festival_id, chain_id, event_id, sequence, schema_version,
  kind, recorded_at, previous_hash, hash, source_terminal_id, protocol_version, ledger_canonicalization, payload_canonical, transport_fingerprint)
  select '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.chain_id(1),
    'closure:bytes', 9, 1, 'closure', '2026-10-14T08:00:00.000000001Z', md5('closure:recurrence') || md5('closure:recurrence'),
    repeat('b', 64), 'terminal:1', 1, 'ts-ledger-v1', original, repeat('c', 64) from exact_payload;
select pg_temp.add_receipt(pg_temp.chain_id(1), 'closure:bytes');
select is((select encode(convert_to(payload_canonical, 'UTF8'), 'hex') from pos_private.ledger_events where event_id = 'closure:bytes'),
  (select encode(convert_to(original, 'UTF8'), 'hex') from exact_payload), 'Original UTF-8 bytes, escapes and key order preserved');
select is((select recorded_at from pos_private.ledger_events where event_id = 'closure:bytes'),
  '2026-10-14T08:00:00.000000001Z', 'Historical timestamp precision is never normalized to PostgreSQL timestamptz');
set constraints all immediate;
select * from finish();
rollback;
