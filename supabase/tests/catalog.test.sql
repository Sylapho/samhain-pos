begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();
\ir fixtures/pos.psql

insert into auth.sessions(id,user_id) values
 ('50000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000004'),
 ('50000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003'),
 ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
create function pg_temp.catalog_body(expected integer default 0) returns jsonb language sql as $$
 select jsonb_build_object('action','publish','organizationId','00000000-0000-0000-0000-000000000001',
 'festivalId','10000000-0000-0000-0000-000000000001','expectedRevision',expected,
 'products',jsonb_build_array(jsonb_build_object('id','test-product','name','Fixture','priceCents',500,'vatRate',10,
 'categoryId','test-category','active',true,'displayOrder',0,'requiresPreparation',false,'availability','available','dataConfidence','confirmed')),
 'categories',jsonb_build_array(jsonb_build_object('id','test-category','label','Fixture category','active',true,'displayOrder',0)))
$$;
create function pg_temp.publish_catalog(expected integer default 0) returns jsonb language sql as $$
 select public.catalog_v1('30000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004',pg_temp.catalog_body(expected),null)
$$;

select throws_ok('select pg_temp.publish_catalog()', '42501','PUBLISH_DENIED','Enrollment manager is not a catalogue publisher');
insert into pos_private.scope_grants values('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000004','publish_catalog',true);
select lives_ok('select pg_temp.publish_catalog()', 'Scoped publisher creates a complete publication');
update auth.users set is_anonymous=true where id='30000000-0000-0000-0000-000000000004';
select throws_ok('select pg_temp.publish_catalog(1)','42501','PUBLISH_DENIED','Anonymous account cannot publish even with an erroneous explicit grant');
update auth.users set is_anonymous=false where id='30000000-0000-0000-0000-000000000004';
select is((select revision from pos_private.catalog_heads limit 1),1::bigint,'Publication advances the version atomically');
select is((select (payload::jsonb)->>'schemaVersion' from pos_private.catalog_versions limit 1),'1','Schema is explicit');
select is((select sha256::text from pos_private.catalog_versions limit 1),
 (select encode(digest(convert_to(payload,'UTF8'),'sha256'),'hex') from pos_private.catalog_versions limit 1),'Hash covers exact UTF-8 document');
select throws_ok('select pg_temp.publish_catalog()', '40001','CATALOG_HEAD_MOVED','Stale optimistic publication refused');
select is((select count(*) from pos_private.catalog_versions),1::bigint,'Stale publication writes nothing');
select throws_ok($$select public.catalog_v1('30000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003',pg_temp.catalog_body(1),null)$$,
 '42501','PUBLISH_DENIED','Auditor cannot publish');
select throws_ok($$select public.catalog_v1('30000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004',
 jsonb_set(pg_temp.catalog_body(1),'{organizationId}','"00000000-0000-0000-0000-000000000002"'),null)$$,
 '42501','PUBLISH_DENIED','Forged scope does not authorize publication');
select throws_ok($$select public.catalog_v1('30000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004',
 jsonb_set(pg_temp.catalog_body(1),'{products,0,categoryId}','"missing"'),null)$$,'P0001','INVALID_CATALOG','Orphan product refuses the whole publication');
select throws_ok($$select public.catalog_v1('30000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004',
 jsonb_set(pg_temp.catalog_body(1),'{products,0,dataConfidence}','"temporary"'),null)$$,'P0001','INVALID_CATALOG','Temporary business data cannot be published');
select throws_ok($$update pos_private.catalog_versions set payload='{}'$$,'P0001','Published catalogues are immutable','Published history cannot be rewritten');
select throws_ok($$delete from pos_private.catalog_versions$$,'P0001','Published catalogues are immutable','Published history cannot be deleted');

-- Synthetic registered installation and one-use challenge, exercising the real #114 proof consumer.
insert into pos_private.enrollment_requests(request_id,auth_subject,installation_id,public_key,dossier,consumed_at)
 values('60000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',repeat('a',400),'{}',now());
insert into pos_private.installation_keys(installation_id,public_key,continuity_state,request_id)
 values('40000000-0000-0000-0000-000000000001',repeat('a',400),'ready','60000000-0000-0000-0000-000000000001');
create function pg_temp.read_catalog() returns jsonb language plpgsql as $$ declare nonce uuid; begin
 insert into pos_private.auth_challenges(auth_subject,installation_id,expires_at)
 values('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',clock_timestamp()+interval '60 seconds')
 on conflict(auth_subject) do update set nonce=gen_random_uuid(),expires_at=clock_timestamp()+interval '60 seconds' returning auth_challenges.nonce into nonce;
 return public.catalog_v1('30000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',jsonb_build_object(
 'action','read','organizationId','00000000-0000-0000-0000-000000000001','festivalId','10000000-0000-0000-0000-000000000001',
 'chainId',pg_temp.chain_id(1),'installationId','40000000-0000-0000-0000-000000000001','enrollmentGeneration',1),nonce);
end $$;
select is((pg_temp.read_catalog()->'version'->>'payload')::jsonb->>'revision','1','Enrolled tablet reads a complete version');
update pos_private.installations set active=false,revoked_at=clock_timestamp() where installation_id='40000000-0000-0000-0000-000000000001';
select throws_ok('select pg_temp.read_catalog()','42501','INSTALLATION_DENIED','Revoked installation cannot download');
update pos_private.scope_grants set active=false where capability='publish_catalog';
select throws_ok('select pg_temp.publish_catalog(1)','42501','PUBLISH_DENIED','Revoked publisher cannot publish with a live JWT');
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='50000000-0000-0000-0000-000000000004';
select throws_ok('select pg_temp.publish_catalog(1)','P0001','AUTH_REQUIRED','Expired live session refuses publication');

set local role anon;
select throws_ok($$select * from pos_private.catalog_versions$$,'42501',null,'Anonymous direct table read denied');
select throws_ok($$select public.catalog_v1(null,null,'{}',null)$$,'42501',null,'Anonymous RPC denied');
reset role;
set local role authenticated;
select throws_ok($$select * from pos_private.catalog_versions$$,'42501',null,'Authenticated direct table read denied');
select throws_ok($$select public.catalog_v1(null,null,'{}',null)$$,'42501',null,'Authenticated privileged RPC denied');
reset role;
set local role service_role;
select throws_ok($$insert into pos_private.catalog_heads values(null,null,0)$$,'42501',null,'Even service role cannot bypass publication RPC');
reset role;
select ok(not has_function_privilege('authenticated','pos_private.require_catalog_account(uuid)','EXECUTE'),'Account helper is private');
select ok(not has_table_privilege('pos_catalog_executor','pos_private.ledger_events','INSERT,UPDATE,DELETE'),'Catalogue executor cannot mutate financial history');
select * from finish();
rollback;
