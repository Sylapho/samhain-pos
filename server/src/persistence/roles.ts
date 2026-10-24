import type { Db, Document } from 'mongodb'
import { definitions } from './schema.ts'
import { PersistenceError } from './errors.ts'
import { stable } from './migrations.ts'

const immutable = [
  'ledgerEvents',
  'sales',
  'syncReceipts',
  'catalogVersions',
  'administrationAudit',
  'schemaMigrations',
]
export function roleDefinitions(database: string) {
  const privilege = (collection: string, actions: string[]) => ({
    resource: { db: database, collection },
    actions,
  })
  const read = [
    privilege('', ['listCollections']),
    ...definitions.map(({ name }) => privilege(name, ['find'])),
  ]
  const update = [
    'organizations',
    'festivals',
    'scopeGrants',
    'authorizationGuards',
    'installations',
    'apiSessions',
    'chains',
    'authChallenges',
    'catalogHeads',
    'enrollmentRequests',
  ]
  const insert = definitions
    .filter(({ name }) => name !== 'schemaMigrations')
    .map(({ name }) => privilege(name, ['insert']))
  return [
    {
      role: 'samhain_runtime_v1',
      privileges: [...read, ...insert, ...update.map((name) => privilege(name, ['update']))],
      roles: [],
    },
    {
      // Explicit new role: v1 grants are not silently broadened by an upgrade.
      role: 'samhain_runtime_v2',
      privileges: [
        ...read,
        ...insert,
        ...[...update, 'terminalRanges'].map((name) => privilege(name, ['update'])),
      ],
      roles: [],
    },
    {
      role: 'samhain_reader_v1',
      privileges: [
        'organizations',
        'festivals',
        'chains',
        'ledgerEvents',
        'sales',
        'syncReceipts',
        'catalogVersions',
        'catalogHeads',
      ].map((name) => privilege(name, ['find'])),
      roles: [],
    },
    {
      role: 'samhain_migrator_v1',
      privileges: [
        privilege('', ['listCollections']),
        ...definitions.map(({ name }) =>
          privilege(name, ['find', 'createCollection', 'createIndex', 'collMod']),
        ),
        privilege('schemaMigrations', ['insert']),
      ],
      roles: [],
    },
  ]
}

export async function installRoles(db: Db): Promise<void> {
  for (const role of roleDefinitions(db.databaseName)) {
    const result = await db.command({
      rolesInfo: { role: role.role, db: db.databaseName },
      showPrivileges: true,
    })
    const existing = result.roles[0]
    if (existing) {
      const normalize = (privileges: Document[]) => {
        // MongoDB merges privileges targeting the same resource when storing roles.
        const merged = new Map<string, { resource: Document; actions: Set<string> }>()
        for (const p of privileges) {
          const key = stable(p.resource)
          const item = merged.get(key) ?? { resource: p.resource, actions: new Set<string>() }
          for (const action of p.actions) item.actions.add(action)
          merged.set(key, item)
        }
        return [...merged.values()]
          .map((p) => ({ resource: p.resource, actions: [...p.actions].sort() }))
          .sort((a, b) => stable(a).localeCompare(stable(b)))
      }
      if (
        existing.roles.length ||
        stable(normalize(existing.privileges)) !== stable(normalize(role.privileges))
      )
        throw new PersistenceError('SCHEMA_INCOMPATIBLE', 'roles')
    } else
      await db.command({ createRole: role.role, privileges: role.privileges, roles: role.roles })
  }
}

// Check effective privileges, including inherited/custom roles. Granting readWrite
// or bypassDocumentValidation would defeat append-only protection.
export async function verifyRuntimePrivileges(
  db: Db,
  signal?: AbortSignal,
  requireAuth = false,
): Promise<void> {
  const result = await db.command(
    { connectionStatus: 1, showPrivileges: true },
    signal ? { signal } : {},
  )
  if (!result.authInfo?.authenticatedUsers?.length)
    throw new PersistenceError('SCOPE_DENIED', 'roles')
  if (
    requireAuth &&
    !(result.authInfo.authenticatedUserPrivileges ?? []).some(
      (p: Document) =>
        p.resource.db === db.databaseName &&
        p.resource.collection === 'terminalRanges' &&
        p.actions.includes('update'),
    )
  ) {
    throw new PersistenceError('SCOPE_DENIED', 'roles')
  }
  for (const privilege of result.authInfo.authenticatedUserPrivileges ?? []) {
    const resource = privilege.resource
    const applies =
      resource.cluster ||
      resource.anyResource ||
      resource.db === '' ||
      resource.db === db.databaseName
    if (!applies) continue
    const actions: string[] = privilege.actions
    if (
      resource.cluster ||
      actions.some(
        (action) =>
          !['find', 'insert', 'update', 'listCollections', 'listIndexes', 'killCursors'].includes(
            action,
          ),
      ) ||
      (immutable.some(
        (name) =>
          resource.anyResource || resource.collection === '' || resource.collection === name,
      ) &&
        actions.some((action) => ['update', 'remove'].includes(action)))
    )
      throw new PersistenceError('SCOPE_DENIED', 'roles')
  }
}
