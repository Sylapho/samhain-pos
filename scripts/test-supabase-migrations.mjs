import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const project = 'samhain-pos'
const tables = [
  'organizations',
  'festivals',
  'chains',
  'installations',
  'scope_grants',
  'terminal_ranges',
  'ledger_events',
  'sales',
  'sync_receipts',
]

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

function sql(input) {
  return run(
    'docker',
    [
      'exec',
      '-i',
      `supabase_db_${project}`,
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
    input,
  )
}

// Always local: no hosted URL, linking, secret or remote reset option.
try {
  if (
    !readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8').includes(
      `project_id = "${project}"`,
    )
  ) {
    throw new Error('Unexpected local Supabase project; refusing to reset it.')
  }
  const first = readdirSync(new URL('../supabase/migrations/', import.meta.url)).sort()[0]
  console.log('Resetting the disposable LOCAL database to the initial migration.')
  run('supabase', ['db', 'reset', '--local', '--no-seed', '--version', first.split('_')[0]])
  const fixture = readFileSync(
    new URL('../supabase/tests/fixtures/pos.psql', import.meta.url),
    'utf8',
  )
  sql(`begin;\n${fixture}\ncommit;`)
  const snapshot = `select jsonb_build_object(${tables
    .map(
      (table) =>
        `'${table}', (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from pos_private.${table} t)`,
    )
    .join(',')})::text;`
  const before = sql(snapshot)
  run('supabase', ['migration', 'up', '--local'])
  if (sql(snapshot) !== before) throw new Error('Additive migration changed existing records.')
  console.log(
    'PASS: every financial payload, receipt, head and enrollment preserved byte-for-byte in its SQL representation.',
  )
  run('supabase', ['db', 'reset', '--local', '--no-seed'])
  console.log('PASS: all migrations reconstructed the empty local database; ready for pgTAP.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
