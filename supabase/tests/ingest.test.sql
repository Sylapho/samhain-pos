begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();

select is(pos_private.sync_canonical('{"z":null,"a":1,"n":-0,"arr":[true,"é😀"]}'::json),
  '{"a":1,"arr":[true,"é😀"],"n":0,"z":null}', 'Canonical arrays, absent/null, negative zero, accents and emoji');
select is(pos_private.sync_canonical('{"":1,"😀":2}'::json),'{"😀":2,"":1}', 'UTF-16 order differs from UTF-8/database collation');
select is(pos_private.sync_canonical('{"s":"</x>/\u2028\u2029\n\u0001"}'::json,'android-ledger-v1'),
  '{"s":"<\/x>\/' || chr(8232) || chr(8233) || '\n\u0001"}', 'Android platform JSONStringer escaping');
select is(pos_private.sync_canonical('{"a":9007199254740991,"b":-9007199254740991,"n":1e3}'::json),
  '{"a":9007199254740991,"b":-9007199254740991,"n":1000}', 'Safe integer boundary and plain notation');
select throws_ok($$select pos_private.sync_canonical('{"x":1,"x":2}'::json)$$,'P0001','INVALID_PAYLOAD','Duplicate keys rejected before JSONB conversion');
select throws_ok($$select pos_private.sync_canonical('{"a":{"x":1,"\u0078":2}}'::json)$$,'P0001','INVALID_PAYLOAD','Escaped nested duplicate keys rejected');
select throws_ok($$select pos_private.sync_canonical('9007199254740991.1'::json)$$,'P0001','INVALID_PAYLOAD','No floating point rounding of unsafe input');
select throws_ok($$select pos_private.sync_canonical('9007199254740992'::json)$$,'P0001','INVALID_PAYLOAD','Unsafe integer rejected');
select throws_ok($$select pos_private.sync_canonical('1.5'::json)$$,'P0001','INVALID_PAYLOAD','Fractional cent rejected');
select throws_ok($$select pos_private.sync_canonical('{}'::json,'unknown')$$,'P0001','CANONICALIZATION_UNSUPPORTED','Profiles are explicit');
select throws_ok($$select pos_private.sync_request('{"protocolVersion":2}','ledger')$$,'P0001','PROTOCOL_UNSUPPORTED','Unknown protocol needs recovery');
select throws_ok($$select pos_private.sync_request(repeat(' ',1048577),'ledger')$$,'P0001','BATCH_TOO_LARGE','SQL independently enforces raw request size');
select is(pos_private.sync_sha('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'Server uses SHA-256 UTF-8');
select is(pos_private.sync_sha(pos_private.sync_canonical('{"previousHash":null,"n":9007199254740991,"id":"é😀</x>/"}'::json)),
  'c81007f4eea9d748ac5a6f0341524d18d9e643dab12f0951b1ffdd379534fc70','Frozen TS hash vector');
select is(pos_private.sync_sha(pos_private.sync_canonical('{"previousHash":null,"n":9007199254740991,"id":"é😀</x>/"}'::json,'android-ledger-v1')),
  '97dedfa5fa794d60f77027e737c065e809e9fb68466f7b8e3db14207c53d784b','Frozen Kotlin/Android hash vector');

select ok(not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls,
  'Financial owner is bounded and cannot log in') from pg_roles where rolname='pos_ledger_executor';
select ok(not pg_has_role(role_name,'pos_ledger_executor','MEMBER'),'API cannot assume financial owner: '||role_name)
  from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_schema_privilege('pos_ledger_executor','public','CREATE') and not has_schema_privilege('pos_ledger_executor','pos_private','CREATE'),
  'Executor cannot modify SQL/schema');
select ok(not has_table_privilege('pos_ledger_executor',table_name,'DELETE,TRUNCATE,UPDATE'), 'Executor cannot rewrite financial records: '||table_name)
  from unnest(array['pos_private.ledger_events','pos_private.sales','pos_private.sync_receipts']) table_name;
select ok(p.prosecdef and p.proowner='pos_ledger_executor'::regrole and p.proconfig @> array['search_path=""'] and
  has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and
  not has_function_privilege('anon',p.oid,'EXECUTE'), 'Only service RPC, bounded definer, empty search path: '||p.proname)
  from pg_proc p where p.oid in ('public.ledger_ingest_v1(uuid,uuid,text,uuid)'::regprocedure,
    'public.legacy_import_v1(uuid,uuid,text,uuid)'::regprocedure,'public.ledger_prefix_v1(uuid,uuid,text,uuid)'::regprocedure);
select ok(not has_function_privilege(role_name,'pos_private.require_sync_session(uuid,uuid)','EXECUTE'),
  'Closed live session helper: '||role_name) from unnest(array['anon','authenticated','service_role']) role_name;

set local role authenticated;
select throws_ok($$select public.ledger_ingest_v1(null,null,'{}',null)$$,'42501',null,'Direct ingestion RPC denied');
select throws_ok($$select public.legacy_import_v1(null,null,'{}',null)$$,'42501',null,'Direct legacy RPC denied');
select throws_ok($$select public.ledger_prefix_v1(null,null,'{}',null)$$,'42501',null,'Direct prefix RPC denied');
select throws_ok($$insert into pos_private.ledger_events(event_id) values('forged')$$,'42501',null,'Direct financial insert denied');
select throws_ok($$select pos_private.consume_installation_proof(null,'{}',null,true)$$,'42501',null,'Recovery proof overload is not exposed');
reset role;
set local role service_role;
select throws_ok($$insert into pos_private.sales(order_id) values('forged')$$,'42501',null,'Service role has RPC only, no direct inserts');
reset role;

select * from finish();
rollback;
