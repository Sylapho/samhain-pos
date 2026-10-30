import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(new URL('../.tmp/', import.meta.url), { recursive: true })
const files = [
  'server/Dockerfile',
  'server/.dockerignore',
  'server/package.json',
  'server/pnpm-lock.yaml',
  'server/tsconfig.json',
  'server/src',
  'server/compose.witches.yaml',
  'server/api.witches.env.example',
  'server/Caddyfile.witches.example',
]
const result = spawnSync(
  'tar',
  [
    '-czf',
    '.tmp/samhain-witches-server-source.tar.gz',
    '--exclude=.env',
    '--exclude=.env.*',
    '--exclude=*.pem',
    '--exclude=*.key',
    '--exclude=*.crt',
    ...files,
  ],
  { cwd: root, stdio: 'inherit', shell: false },
)
if (result.error || result.status !== 0) {
  console.error('Archive API non créée. Vérifiez que la commande tar est disponible.')
  process.exitCode = 1
} else {
  console.log('Archive API : .tmp/samhain-witches-server-source.tar.gz (sans secrets).')
}
