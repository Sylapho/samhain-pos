import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cli, localStatus } from './lib/supabase-local.mjs'

// This command owns/reset ONLY the disposable project in supabase/config.toml.
// No link, hosted URL, db push, production env file or service key argument.
if (!/^project_id = "samhain-pos"$/m.test(readFileSync('supabase/config.toml', 'utf8')))
  throw new Error('Unexpected local test project')
const serverOnly = process.argv.includes('--server-only')
if (process.argv.slice(2).some((arg) => arg !== '--server-only'))
  throw new Error('Unknown argument')
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const report = {
  date: new Date().toISOString(),
  commit,
  workingTreeModified: Boolean(
    spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim(),
  ),
  environment: 'local Supabase Docker only',
  room: !serverOnly,
  steps: [],
}
mkdirSync('reports', { recursive: true })
function run(name, command, args, quiet = false) {
  console.log(`RUN: ${name}`)
  return new Promise((resolve, reject) => {
    const step = { name, status: 'running' }
    report.steps.push(step)
    const child = spawn(command, args, { shell: false, stdio: quiet ? 'ignore' : 'inherit' })
    child.on('error', () => {
      step.status = 'failed'
      reject(new Error(`${name}: executable unavailable`))
    })
    child.on('close', (code) => {
      step.status = code === 0 ? 'passed' : 'failed'
      if (code === 0) resolve()
      else reject(new Error(`${name}: failed (exit ${code})`))
    })
  })
}
try {
  await run('Supabase CLI version', cli, ['--version'])
  // start/status can print local keys: do not forward either stream.
  await run('Start isolated local stack', cli, ['start'], true)
  localStatus()
  await run('Historical migrations and clean reset', process.execPath, [
    'scripts/test-supabase-migrations.mjs',
  ])
  await run('SQL policies, grants, RPC and financial invariants', cli, ['test', 'db'])
  await run('SQL lint', cli, [
    'db',
    'lint',
    '--local',
    '--schema',
    'pos_private',
    '--fail-on',
    'error',
  ])
  const functions = [
    'tablet-auth-v1',
    'ledger-ingest-v1',
    'legacy-import-v1',
    'ledger-prefix-v1',
    'catalog-v1',
  ]
  await run('Edge typecheck', 'deno', [
    'check',
    ...functions.map((name) => `supabase/functions/${name}/index.ts`),
  ])
  await run('Edge protocol and Auth unit tests (Vitest)', process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    'supabase/functions/_shared',
  ])
  await run('Concurrent SQL activation', process.execPath, [
    'scripts/test-supabase-enrollment-concurrency.mjs',
  ])
  await run('Real Auth, enrollment, Edge and PostgreSQL campaign', process.execPath, [
    'scripts/test-supabase-ingest.mjs',
  ])
  if (!serverOnly)
    await run('Real Room to isolated Supabase', process.execPath, [
      'scripts/test-supabase-room.mjs',
    ])
  console.log(
    `PASS: isolated Supabase campaign${serverOnly ? ' (server only; Room not executed)' : ' including Room'}`,
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  // Always stop; preserve local volumes for inspection until the next explicit test reset.
  try {
    await run('Stop isolated local stack', cli, ['stop', '--project-id', 'samhain-pos'], true)
  } catch {
    process.exitCode = 1
  }
  writeFileSync('reports/supabase-integration.json', JSON.stringify(report, null, 2) + '\n')
}
