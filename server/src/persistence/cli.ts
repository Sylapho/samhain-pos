import { loadConfig } from '../config.ts'
import { createMongoClient } from '../database.ts'
import { migrate, verifySchema } from './migrations.ts'
import { installRoles, verifyRuntimePrivileges } from './roles.ts'
import { PersistenceError } from './errors.ts'
import { auditEvidence } from './audit.ts'

const action = process.argv[2]
let client: ReturnType<typeof createMongoClient> | undefined
try {
  if (!['migrate', 'verify', 'roles', 'verify-runtime', 'audit'].includes(action ?? ''))
    throw new Error('INVALID_COMMAND')
  const config = loadConfig()
  if (
    ['migrate', 'roles'].includes(action!) &&
    process.env.MONGODB_ADMIN_TARGET !== config.mongoDatabase
  )
    throw new Error('EXPLICIT_TARGET_REQUIRED')
  client = createMongoClient(config)
  await client.connect()
  const db = client.db(config.mongoDatabase)
  if (action === 'migrate') await migrate(db)
  else if (action === 'roles') await installRoles(db)
  else if (action === 'audit') await auditEvidence(db)
  else {
    await verifySchema(db)
    if (action === 'verify-runtime')
      await verifyRuntimePrivileges(db, undefined, config.auth !== null)
  }
  process.stdout.write(JSON.stringify({ event: 'persistence_check', action, status: 'ok' }) + '\n')
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      event: 'persistence_check',
      status: 'failed',
      code: error instanceof PersistenceError ? error.code : 'PERSISTENCE_CHECK_FAILED',
      ...(error instanceof PersistenceError && error.collection
        ? { collection: error.collection, index: error.index }
        : {}),
    }) + '\n',
  )
  process.exitCode = 1
} finally {
  await client?.close()
}
