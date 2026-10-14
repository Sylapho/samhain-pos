begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();
\ir fixtures/pos.psql
insert into auth.users(id) select ('30000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid from generate_series(10,30) n;

create function pg_temp.subject(n integer) returns uuid language sql as $$ select ('30000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.device(n integer) returns uuid language sql as $$ select ('40000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.request_device(n integer, prefix jsonb default '[]', restored boolean default false) returns jsonb language sql as $$
  select public.tablet_auth_v1(pg_temp.subject(n),'request',jsonb_build_object('installationId',pg_temp.device(n),
    'publicKey',repeat('a',400),'terminalId','terminal:1','chainId',pg_temp.chain_id(100),'restored',restored,'prefix',prefix))
$$;
create function pg_temp.approve_device(n integer, chain uuid default pg_temp.chain_id(100), replaces uuid default null) returns jsonb language sql as $$
  select public.tablet_auth_v1(pg_temp.subject(4),'approve',jsonb_build_object(
    'requestId',(select request_id from pos_private.enrollment_requests where auth_subject=pg_temp.subject(n)),
    'organizationId','00000000-0000-0000-0000-000000000001','festivalId','10000000-0000-0000-0000-000000000001',
    'chainId',chain,'replacesInstallationId',replaces,'invitationHash',lpad(n::text,64,'b')))
$$;
create function pg_temp.device_action(n integer, action text, extra jsonb default '{}') returns jsonb language plpgsql as $$
declare ch jsonb; begin
  ch := public.tablet_auth_v1(pg_temp.subject(n),'challenge',jsonb_build_object('installationId',pg_temp.device(n)));
  return public.tablet_auth_v1(pg_temp.subject(n),action,jsonb_build_object('installationId',pg_temp.device(n),'invitationHash',lpad(n::text,64,'b'))||extra,(ch->>'nonce')::uuid);
end $$;

select lives_ok('select pg_temp.request_device(10)','Tablet can request but cannot approve itself');
select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(10),'approve',jsonb_build_object('requestId',
  (select request_id from pos_private.enrollment_requests where auth_subject=pg_temp.subject(10)),
  'organizationId','00000000-0000-0000-0000-000000000001','festivalId','10000000-0000-0000-0000-000000000001',
  'chainId',pg_temp.chain_id(100),'invitationHash',repeat('b',64)))$$,'42501','MANAGER_REQUIRED','Enrollment without manager denied');
select lives_ok('select pg_temp.approve_device(10)','Authorized scoped manager approves');
select is(pg_temp.device_action(10,'activate')->>'status','authorized','Single-use activation works');
select is(pg_temp.device_action(10,'activate')->>'status','invitation_used','Consumed invitation cannot activate twice');
select is((select count(*) from pos_private.installations where auth_subject=pg_temp.subject(10)),1::bigint,'Exactly one installation activated');

select lives_ok('select pg_temp.request_device(11)','Second tablet requests');
select lives_ok('select pg_temp.approve_device(11,pg_temp.chain_id(101))','Approve second request');
update pos_private.enrollment_requests set invitation_expires_at = clock_timestamp()-interval '1 second' where auth_subject=pg_temp.subject(11);
select is(pg_temp.device_action(11,'activate')->>'status','invitation_expired','Expired code denied');
select is((select count(*) from pos_private.installations where auth_subject=pg_temp.subject(11)),0::bigint,'Expired code has no side effects');

select lives_ok('select pg_temp.request_device(12)','Request for attempts test');
select lives_ok('select pg_temp.approve_device(12,pg_temp.chain_id(102))','Approve attempts fixture');
select is(pg_temp.device_action(12,'activate',jsonb_build_object('invitationHash',repeat('c',64)))->>'status','invitation_invalid','Bad code denied') from generate_series(1,5);
select is(pg_temp.device_action(12,'activate')->>'status','attempts_exceeded','Failed attempts survive and bound guessing');

select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(10),'challenge',jsonb_build_object('installationId',pg_temp.device(11)))$$,
  '42501','INSTALLATION_DENIED','Installation A cannot claim B');
select throws_ok($$select pg_temp.device_action(10,'authorize',jsonb_build_object('organizationId','00000000-0000-0000-0000-000000000002',
  'festivalId','10000000-0000-0000-0000-000000000001','chainId',pg_temp.chain_id(100),'enrollmentGeneration',1))$$,
  '42501','INSTALLATION_DENIED','Wrong organization denied');
select throws_ok($$select pg_temp.device_action(10,'authorize',jsonb_build_object('organizationId','00000000-0000-0000-0000-000000000001',
  'festivalId','10000000-0000-0000-0000-000000000002','chainId',pg_temp.chain_id(100),'enrollmentGeneration',1))$$,
  '42501','INSTALLATION_DENIED','Wrong festival denied');
select throws_ok($$select pg_temp.device_action(10,'authorize',jsonb_build_object('organizationId','00000000-0000-0000-0000-000000000001',
  'festivalId','10000000-0000-0000-0000-000000000001','chainId',pg_temp.chain_id(100),'enrollmentGeneration',1,'terminalId','forged','sequence',1))$$,
  '42501','TERMINAL_DENIED','Unauthorized historical terminal denied');

select set_config('request.jwt.claim.sub',pg_temp.subject(10)::text,true);
set local role authenticated;
select throws_ok($$select public.tablet_auth_v1(null,'approve','{}')$$,'42501',null,'Direct privileged RPC denied');
select throws_ok('select * from pos_private.installation_keys','42501',null,'Direct key registry access denied');
select is((select count(*) from pos_private.chains),0::bigint,'Enrolled device cannot bypass possession proof with direct reads');
select throws_ok('insert into pos_private.enrollment_requests(auth_subject) values(null)','42501',null,'Client cannot enroll by table insert');
reset role;

select lives_ok('select pg_temp.request_device(13)','Replacement request');
select throws_ok('select pg_temp.approve_device(13)','22023','REPLACEMENT_CONFIRMATION_REQUIRED','Second installation requires explicit replacement');
select lives_ok('select pg_temp.approve_device(13,pg_temp.chain_id(100),pg_temp.device(10))','Explicit replacement approved');
select is(pg_temp.device_action(13,'activate')->>'status','authorized','Replacement is authorized');
select is((select enrollment_generation::bigint from pos_private.chains where chain_id=pg_temp.chain_id(100)),2::bigint,'Generation advanced once');
select is(pg_temp.device_action(10,'status')->>'status','revoked','Old still-valid principal refused immediately');
select is((select count(*) from pos_private.installations where chain_id=pg_temp.chain_id(100) and active),1::bigint,'Only one active installation');

select lives_ok('select pg_temp.request_device(14)','Restored old archive request');
select lives_ok('select pg_temp.approve_device(14,pg_temp.chain_id(1),pg_temp.device(1))','Responsible approves old archive replacement');
select is(pg_temp.device_action(14,'activate')->>'status','needs_recovery','Remote suffix absent locally requires recovery');
select is((select head_sequence from pos_private.chains where chain_id=pg_temp.chain_id(1)),6::bigint,'Remote head never rolls back');
select is((select count(*) from pos_private.ledger_events where chain_id=pg_temp.chain_id(1)),6::bigint,'No financial event deleted');
select throws_ok($$select pg_temp.device_action(14,'authorize',jsonb_build_object('organizationId','00000000-0000-0000-0000-000000000001',
  'festivalId','10000000-0000-0000-0000-000000000001','chainId',pg_temp.chain_id(1),'enrollmentGeneration',2))$$,
  '42501','INSTALLATION_DENIED','Recovery installation cannot continue ledger');

select lives_ok($$select pg_temp.request_device(15,(select jsonb_agg(jsonb_build_object('sequence',sequence,'eventId',event_id,
  'hash',case when sequence=3 then repeat('f',64) else hash end,'terminalId',source_terminal_id) order by sequence)
  from pos_private.ledger_events where chain_id=pg_temp.chain_id(1)),true)$$,'Divergent archive dossier');
select lives_ok('select pg_temp.approve_device(15,pg_temp.chain_id(1),pg_temp.device(14))','Divergent replacement explicitly approved');
select is(pg_temp.device_action(15,'activate')->>'status','needs_recovery','Divergent prefix quarantines synchronization');
select is((select head_sequence from pos_private.chains where chain_id=pg_temp.chain_id(1)),6::bigint,'Divergence preserves original remote branch');

select lives_ok($$select public.tablet_auth_v1(pg_temp.subject(4),'revoke',jsonb_build_object('chainId',pg_temp.chain_id(100),'installationId',pg_temp.device(13)))$$,'Manager revokes tablet');
select is(pg_temp.device_action(13,'status')->>'status','revoked','Revocation takes effect without JWT expiry');
select ok(not has_function_privilege('authenticated','pos_private.require_installation(uuid,jsonb)','execute'),'Protected authorization helper not exposed');
select ok(not has_table_privilege('pos_enrollment_executor','pos_private.ledger_events','insert,update,delete'),'Enrollment owner cannot mutate financial events');
select ok(not pg_has_role('service_role','pos_enrollment_executor','member'),'Service role cannot assume enrollment owner');

select lives_ok('select pg_temp.request_device(16)','Request awaiting live grant check');
select lives_ok('select pg_temp.approve_device(16,pg_temp.chain_id(104))','Manager initially authorized');
update pos_private.scope_grants set active=false where auth_subject=pg_temp.subject(4);
select throws_ok($$select pg_temp.device_action(16,'activate')$$,'42501','MANAGER_REQUIRED','Withdrawn approver capability invalidates pending invitation');
select is((select count(*) from pos_private.installations where auth_subject=pg_temp.subject(16)),0::bigint,'Withdrawn approval has no activation side effect');
update pos_private.scope_grants set active=true where auth_subject=pg_temp.subject(4);

select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(4),'approve',jsonb_build_object('requestId',
  (select request_id from pos_private.enrollment_requests where auth_subject=pg_temp.subject(16)),
  'organizationId','00000000-0000-0000-0000-000000000002','festivalId','10000000-0000-0000-0000-000000000003',
  'chainId',pg_temp.chain_id(105),'invitationHash',repeat('e',64)))$$,'42501','MANAGER_REQUIRED','Manager cannot approve another organization');

select lives_ok('select pg_temp.request_device(17)','Challenge rate-limit fixture');
do $$ begin
  for n in 1..60 loop perform public.tablet_auth_v1(pg_temp.subject(17),'challenge',jsonb_build_object('installationId',pg_temp.device(17))); end loop;
end $$;
select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(17),'challenge',jsonb_build_object('installationId',pg_temp.device(17)))$$,
  '42501','RATE_LIMITED','Challenge attempts are bounded per principal');

select throws_ok($$select pg_temp.request_device(18,'[{"sequence":1,"eventId":"id","terminalId":"terminal:1"}]')$$,
  '22023','INVALID_PREFIX','Missing prefix hash cannot bypass validation via SQL NULL');
select lives_ok($$select pg_temp.request_device(19,(select jsonb_agg(jsonb_build_object('sequence',sequence,'eventId',event_id,
  'hash',hash,'terminalId',source_terminal_id) order by sequence) from pos_private.ledger_events where chain_id=pg_temp.chain_id(1)))$$,
  'Clone presents existing prefix');
select throws_ok('select pg_temp.approve_device(19,pg_temp.chain_id(105))','22023','EXISTING_CHAIN_REQUIRED','Existing prefix cannot be assigned to a new chain');
select lives_ok('select pg_temp.request_device(20,''[]'',true)','Restored archive without chain ID');
select throws_ok('select pg_temp.approve_device(20,pg_temp.chain_id(106))','22023','RESTORE_MAPPING_REQUIRED','Restoration cannot silently invent a chain mapping');

select is(pg_temp.device_action(13,'status')->>'status','revoked','Revoked status may be queried with a fresh possession proof');
select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(4),'revoke',jsonb_build_object('chainId',pg_temp.chain_id(100),'installationId',pg_temp.device(11)))$$,
  '42501','INSTALLATION_DENIED','Revocation cannot falsely report success for an installation from another chain');
select throws_ok($$select public.tablet_auth_v1(pg_temp.subject(13),'status',jsonb_build_object('installationId',pg_temp.device(13)),
  (select nonce from pos_private.auth_challenges where auth_subject=pg_temp.subject(13)))$$,'42501','PROOF_REQUIRED','Consumed challenge cannot be replayed');
select * from finish();
rollback;
