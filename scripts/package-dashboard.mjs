import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(new URL('../.tmp/', import.meta.url), { recursive: true })
// Explicit allowlist: neither local env files nor certificates, keys, .git or dependencies.
const files = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.app.json',
  'dashboard/Dockerfile',
  'dashboard/Dockerfile.dockerignore',
  'dashboard/compose.yaml',
  'dashboard/Caddyfile',
  'dashboard/install-caddy.sh',
  'dashboard/dashboard.env.example',
  'dashboard/create-reader.mongosh.js',
  'dashboard/index.html',
  'dashboard/tsconfig.json',
  'dashboard/vite.config.ts',
  'dashboard/src',
  'server/package.json',
  'server/pnpm-lock.yaml',
  'server/tsconfig.json',
  'server/src',
  'docs/samhain-witches-setup.md',
]
const result = spawnSync(
  'tar',
  [
    '-czf',
    '.tmp/samhain-witches-dashboard-source.tar.gz',
    '--exclude=.env',
    '--exclude=.env.*',
    '--exclude=*.pem',
    '--exclude=*.key',
    '--exclude=*.crt',
    ...files,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  },
)
if (result.error || result.status !== 0) {
  console.error('Archive non créée. Vérifiez que la commande tar est disponible.')
  process.exitCode = 1
} else
  console.log(
    'Archive de déploiement : .tmp/samhain-witches-dashboard-source.tar.gz (sans configuration locale ni secrets).',
  )
