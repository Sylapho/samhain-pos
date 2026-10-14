import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import process from 'node:process'

// Only disposable local containers. No URL, credential or hosted database option.
const container = process.env.SAMHAIN_LOCAL_TEST_CONTAINER ?? 'supabase_db_samhain-pos'
if (!['supabase_db_samhain-pos', 'samhain-enrollment-114'].includes(container)) {
  throw new Error('Refusing an unknown database container; use the disposable local test stack.')
}
function sql(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      { shell: false },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', () => {
      /* Do not print SQL/credential-bearing errors. */
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
    child.stdin.end(input)
  })
}
const organization = randomUUID(),
  festival = randomUUID(),
  chain = randomUUID()
const manager = randomUUID(),
  subject = randomUUID(),
  installation = randomUUID()
const invitationHash = randomBytes(32).toString('hex')
const setup = await sql(`
begin;
insert into auth.users(id) values ('${manager}'),('${subject}');
insert into pos_private.organizations(organization_id) values ('${organization}');
insert into pos_private.festivals(organization_id,festival_id) values ('${organization}','${festival}');
insert into pos_private.scope_grants values ('${organization}','${festival}','${manager}','manage_enrollment',true);
select public.tablet_auth_v1('${subject}','request',jsonb_build_object('installationId','${installation}',
  'publicKey',repeat('a',400),'terminalId','concurrency-test-only','chainId','${chain}','restored',false,'prefix','[]'::jsonb));
select public.tablet_auth_v1('${manager}','approve',jsonb_build_object('requestId',
  (select request_id from pos_private.enrollment_requests where auth_subject='${subject}'),
  'organizationId','${organization}','festivalId','${festival}','chainId','${chain}','invitationHash','${invitationHash}'));
select public.tablet_auth_v1('${subject}','challenge',jsonb_build_object('installationId','${installation}'))->>'nonce';
commit;`)
if (setup.code !== 0) throw new Error('Local concurrency fixture setup failed.')
const nonce = setup.output.split(/\r?\n/).find((line) => /^[0-9a-f-]{36}$/.test(line))
if (!nonce) throw new Error('No server challenge returned.')
const activation = `begin;
select public.tablet_auth_v1('${subject}','activate',jsonb_build_object('installationId','${installation}','invitationHash','${invitationHash}'),'${nonce}')->>'status';
select pg_sleep(0.5);
commit;`
const results = await Promise.all([sql(activation), sql(activation)])
if (
  results.filter((result) => result.code === 0 && result.output.includes('authorized')).length !==
    1 ||
  results.filter((result) => result.code !== 0).length !== 1
) {
  throw new Error('Same challenge/invitation activated more or less than once.')
}
const count = await sql(
  `select count(*) from pos_private.installations where chain_id='${chain}' and active;`,
)
if (count.code !== 0 || count.output.trim() !== '1')
  throw new Error('Active installation invariant failed.')
console.log(
  'PASS: two concurrent real SQL activations; exactly one commit and one active installation.',
)
// Immutable registry fixture remains in this disposable LOCAL database until reset.
