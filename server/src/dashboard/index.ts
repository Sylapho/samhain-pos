import { MongoClient } from 'mongodb'
import { dashboardApp } from './server.ts'
import { dashboardConfig } from './config.ts'

const uri = process.env.MONGODB_URI
const database = process.env.MONGODB_DATABASE
if (!uri || !database)
  throw new Error(
    'Configurez MONGODB_URI et MONGODB_DATABASE dans l’environnement du service (voir docs/mongodb-dashboard.md).',
  )
const config = dashboardConfig()
const localTest =
  /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri) && database.startsWith('samhain_test_')
// Never accept TLS bypass options, even if copied from another tool's connection string.
for (const [key, value] of new URLSearchParams(uri.split('?')[1] ?? '')) {
  const name = key.toLowerCase()
  if (
    [
      'tlsallowinvalidcertificates',
      'tlsallowinvalidhostnames',
      'tlsinsecure',
      'sslvalidate',
    ].includes(name) ||
    (!localTest && ['tls', 'ssl'].includes(name) && value.toLowerCase() !== 'true')
  )
    throw new Error('La connexion distante exige une validation TLS complète.')
}
let client: MongoClient | undefined
try {
  client = new MongoClient(uri, {
    tls: !localTest,
    maxPoolSize: 3,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 15000,
    timeoutMS: 15000,
  })
  await client.connect()
  const db = client.db(database)
  const access = await db.command({ connectionStatus: 1, showPrivileges: true })
  const privileges: { actions: string[] }[] = access.authInfo?.authenticatedUserPrivileges ?? []
  if (
    (!localTest && !access.authInfo?.authenticatedUsers?.length) ||
    privileges.some((p) =>
      p.actions.some((a) => !['find', 'listCollections', 'listIndexes', 'killCursors'].includes(a)),
    )
  )
    throw new Error('Utilisez un compte MongoDB en lecture seule, par exemple samhain_reader_v1.')
  const app = await dashboardApp(
    db,
    config.port,
    undefined,
    config.publicOrigin ? { publicOrigin: config.publicOrigin } : {},
  )
  app.addHook('onClose', async () => {
    await client?.close()
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close()
    })
  await app.listen({ host: config.host, port: config.port })
  console.log(
    `Dashboard Samhain : ${config.publicOrigin ?? `http://127.0.0.1:${config.port}`} — ${config.publicOrigin ? 'PUBLIC, sans authentification, ' : ''}lecture seule.`,
  )
} catch {
  await client?.close()
  console.error(
    'Dashboard indisponible. Vérifiez server/.env.dashboard, la connexion TLS et le compte MongoDB en lecture seule. Aucun détail de connexion n’est journalisé.',
  )
  process.exitCode = 1
}
