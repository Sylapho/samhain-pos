import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db, Document } from 'mongodb'
import { installRoles, roleDefinitions } from '../src/persistence/roles.ts'

function roleStore(extraPrivilege = false) {
  const roles = new Map(
    roleDefinitions('samhain_witches').map((role) => [
      role.role,
      {
        ...role,
        privileges: role.privileges.map((privilege) => ({
          ...privilege,
          actions: privilege.actions.filter((action) => action !== 'listIndexes'),
        })),
      },
    ]),
  )
  if (extraPrivilege) roles.get('samhain_runtime_v2')!.privileges[1]!.actions.push('remove')
  const updates: string[] = []
  const db = {
    databaseName: 'samhain_witches',
    async command(command: Document) {
      if (command.rolesInfo)
        return { roles: [roles.get(command.rolesInfo.role) ?? null].filter(Boolean) }
      if (command.updateRole) {
        updates.push(command.updateRole)
        roles.set(command.updateRole, {
          role: command.updateRole,
          roles: command.roles,
          privileges: command.privileges,
        })
        return { ok: 1 }
      }
      throw new Error(`Unexpected command: ${Object.keys(command)[0]}`)
    },
  } as unknown as Db
  return { db, updates }
}

test('upgrades only legacy runtime roles missing index-read permission', async () => {
  const { db, updates } = roleStore()
  await installRoles(db)
  assert.deepEqual(updates, ['samhain_runtime_v1', 'samhain_runtime_v2'])
  await installRoles(db)
  assert.equal(updates.length, 2)
})

test('rejects a runtime role with any other privilege difference', async () => {
  const { db, updates } = roleStore(true)
  await assert.rejects(installRoles(db), { code: 'SCHEMA_INCOMPATIBLE' })
  assert.deepEqual(updates, ['samhain_runtime_v1'])
})
