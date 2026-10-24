import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTransaction } from '../src/persistence/transactions.ts'
import { PersistenceError } from '../src/persistence/errors.ts'
import { definitions } from '../src/persistence/schema.ts'
import { roleDefinitions } from '../src/persistence/roles.ts'
import { fingerprint } from '../src/persistence/proofs.ts'

function labelled(name: string) {
  return { hasErrorLabel: (label: string) => label === name }
}
test('transport fingerprint excludes installation, generation, request and nonce even on a richer typed context', () => {
  const scope = { organizationId: 'organization', festivalId: 'festival', chainId: 'chain' }
  const proof = {
    eventId: 'legacy:opaque',
    sourceTerminalId: 'terminal',
    payloadCanonical: '{"id":"legacy:opaque"}',
  }
  const context = {
    ...scope,
    installationId: 'installation',
    enrollmentGeneration: 99,
    requestId: 'retry',
    nonceHash: 'new-challenge',
  }
  assert.equal(fingerprint(context, proof, true), fingerprint(scope, proof, true))
})
function session(commit: () => Promise<void>, abort: () => void = () => {}) {
  return {
    startTransaction: () => {},
    commitTransaction: commit,
    abortTransaction: async () => {
      abort()
    },
    inTransaction: () => true,
    endSession: async () => {},
  }
}
test('unknown commit result retries the same commit and exposes no result before confirmation', async () => {
  let callbacks = 0
  let commits = 0
  let sessions = 0
  const result = await runTransaction(
    () => {
      sessions++
      return session(async () => {
        if (++commits === 1) throw labelled('UnknownTransactionCommitResult')
      })
    },
    async () => {
      callbacks++
      return 'durable'
    },
  )
  assert.equal(result, 'durable')
  assert.deepEqual({ callbacks, commits, sessions }, { callbacks: 1, commits: 2, sessions: 1 })
})
test('unresolved commit remains uncertain: no false ACK, rollback claim or callback replay', async () => {
  let callbacks = 0
  let commits = 0
  let aborts = 0
  await assert.rejects(
    runTransaction(
      () =>
        session(
          async () => {
            commits++
            throw labelled('UnknownTransactionCommitResult')
          },
          () => {
            aborts++
          },
        ),
      async () => {
        callbacks++
        return { committed: true }
      },
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'COMMIT_UNCERTAIN',
  )
  assert.deepEqual({ callbacks, commits, aborts }, { callbacks: 1, commits: 3, aborts: 0 })
})
test('transient transaction and E11000 retry a bounded fresh transaction, never fabricate a receipt', async () => {
  for (const failure of [labelled('TransientTransactionError'), { code: 11000 }]) {
    let callbacks = 0
    await assert.rejects(
      runTransaction(
        () => session(async () => {}),
        async () => {
          callbacks++
          throw failure
        },
      ),
      (error: unknown) => error instanceof PersistenceError && error.code === 'TRANSACTION_RETRY',
    )
    assert.equal(callbacks, 4)
  }
})
test('network failure, timeout and non-transient abort return sanitized errors without ACK', async () => {
  for (const failure of [
    new Error('mongodb://secret:credential@host/private'),
    { code: 50 },
    new Error('aborted'),
  ]) {
    await assert.rejects(
      runTransaction(
        () =>
          session(async () => {
            throw failure
          }),
        async () => 'not-an-ack',
      ),
      (error: unknown) =>
        error instanceof PersistenceError && error.message === 'TRANSACTION_RETRY',
    )
  }
})
test('aborted HTTP work cannot start/commit; uncertain commit is still resolved on the same session', async () => {
  const controller = new AbortController()
  let committed = 0,
    aborted = 0
  await assert.rejects(
    runTransaction(
      () =>
        session(
          async () => {
            committed++
          },
          () => {
            aborted++
          },
        ),
      async () => {
        controller.abort()
        return 'never-acknowledged'
      },
      { signal: controller.signal },
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'TRANSACTION_RETRY',
  )
  assert.equal(committed, 0)
  assert.equal(aborted, 1)
  let callbacks = 0
  await assert.rejects(
    runTransaction(
      () => session(async () => {}),
      async () => {
        callbacks++
        return true
      },
      { signal: controller.signal },
    ),
  )
  assert.equal(callbacks, 0)
  const uncertain = new AbortController()
  const result = await runTransaction(
    () =>
      session(async () => {
        if (++committed === 1) {
          uncertain.abort()
          throw labelled('UnknownTransactionCommitResult')
        }
      }),
    async () => 'durable',
    { signal: uncertain.signal },
  )
  assert.equal(result, 'durable')
  assert.equal(committed, 2)
})

test('schema manifest prohibits financial TTL and runtime mutations of immutable proofs', () => {
  for (const definition of definitions) {
    if (!['authChallenges', 'refreshRotations'].includes(definition.name))
      assert(definition.indexes.every((index) => index.expireAfterSeconds === undefined))
    assert(definition.indexes.every((index) => typeof index.name === 'string'))
  }
  const role = roleDefinitions('samhain_test_roles')[0]!
  for (const privilege of role.privileges)
    if (
      ['ledgerEvents', 'sales', 'syncReceipts', 'catalogVersions', 'administrationAudit'].includes(
        privilege.resource.collection,
      )
    )
      assert(privilege.actions.every((action) => action === 'find' || action === 'insert'))
  assert(
    role.privileges.every(
      (privilege) =>
        !privilege.actions.includes('remove') &&
        !privilege.actions.includes('bypassDocumentValidation'),
    ),
  )
})
