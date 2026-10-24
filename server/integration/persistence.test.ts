import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MongoClient, MongoNetworkError } from 'mongodb'
import { challenge, event, fixture, seed, testTarget, validatedForStorage } from './fixture.ts'
import { definitions } from '../src/persistence/schema.ts'
import {
  migrate,
  migration,
  stable,
  verifySchema,
  verifyTopology,
} from '../src/persistence/migrations.ts'
import { fingerprint, sha256, ledgerDocument } from '../src/persistence/proofs.ts'
import { PersistenceError } from '../src/persistence/errors.ts'
import { transaction, runTransaction } from '../src/persistence/transactions.ts'
import { installRoles, verifyRuntimePrivileges } from '../src/persistence/roles.ts'
import { auditEvidence } from '../src/persistence/audit.ts'
import type { CatalogVersion, TerminalRange } from '../src/persistence/model.ts'

const integration = {
  skip: !process.env.MONGODB_TEST_URI
    ? 'MongoDB integration not executed: MONGODB_TEST_URI absent'
    : false,
}
const empty = { sequence: 0, hash: null }
const code = (expected: string) => (error: unknown) =>
  error instanceof PersistenceError && error.code === expected

test(
  'uncertain commit after a real durable transaction emits no result; replay returns its original receipt',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const proof = event(context)
    const scope = {
      organizationId: context.organizationId,
      festivalId: context.festivalId,
      chainId: context.chainId,
    }
    const receivedAt = new Date()
    const receiptId = randomUUID()
    let callbacks = 0
    await assert.rejects(
      runTransaction(
        () => {
          const session = f.client.startSession()
          const commit = session.commitTransaction.bind(session)
          // Fault injection at the response boundary; the database commit is real.
          session.commitTransaction = async () => {
            await commit()
            const lost = new MongoNetworkError('Injected lost commit response')
            lost.addErrorLabel('UnknownTransactionCommitResult')
            throw lost
          }
          return session
        },
        async (session) => {
          callbacks++
          const entry = ledgerDocument(scope, proof, receivedAt)
          await f.db.collection('sales').insertOne(
            {
              ...scope,
              documentSchemaVersion: 1,
              type: 'sealed',
              orderId: entry.orderId,
              ledgerEventId: proof.eventId,
              saleHash: proof.hash,
            },
            { session },
          )
          await f.db.collection('ledgerEvents').insertOne(entry, { session })
          await f.db.collection('syncReceipts').insertOne(
            {
              ...scope,
              documentSchemaVersion: 1,
              eventType: 'ledger',
              eventId: proof.eventId,
              sequence: proof.sequence,
              hash: proof.hash,
              transportFingerprint: proof.transportFingerprint,
              receiptId,
              serverReceivedAt: receivedAt,
              installationId: context.installationId,
              enrollmentGeneration: 1,
              issuer: context.issuer,
              subject: context.subject,
              firstRequestId: context.requestId,
            },
            { session },
          )
          await f.db
            .collection('chains')
            .updateOne(
              scope,
              { $set: { head: { sequence: 1, hash: proof.hash } }, $inc: { fence: 1 } },
              { session },
            )
          return { committed: true }
        },
      ),
      code('COMMIT_UNCERTAIN'),
    )
    assert.equal(callbacks, 1)
    await challenge(f.db, context)
    const result = await f.store.persistLedger(context, empty, [proof], validatedForStorage)
    assert.equal(result.receipts[0]?.receiptId, receiptId)
    assert.deepEqual(result.receipts[0]?.serverReceivedAt, receivedAt)
    await auditEvidence(f.db)
  },
)

test('disposable namespace guard rejects production names and missing opt-in without connection', () => {
  const old = { ...process.env }
  try {
    process.env.MONGODB_TEST_DATABASE = 'production'
    assert.throws(testTarget)
    process.env.MONGODB_TEST_DATABASE = 'samhain_test_guard'
    process.env.MONGODB_TEST_DISPOSABLE = 'false'
    assert.throws(testTarget)
  } finally {
    process.env = old
  }
})

test(
  'migration initializes, reruns exactly, preserves documents and installs strict schemas and stable indexes',
  integration,
  async (t) => {
    const f = await fixture(false)
    t.after(() => f.client.close())
    const preserved = {
      documentSchemaVersion: 1,
      organizationId: randomUUID(),
      active: false,
      fence: 0,
    }
    await f.db.collection('organizations').insertOne(preserved)
    await migrate(f.db)
    const before = await f.db.collection('schemaMigrations').findOne({ version: migration.version })
    const metadata = await f.db.listCollections({}, { nameOnly: false }).toArray()
    await migrate(f.db)
    await verifySchema(f.db)
    assert.deepEqual(
      await f.db.collection('schemaMigrations').findOne({ version: migration.version }),
      before,
    )
    assert.deepEqual(await f.db.collection('organizations').findOne(), preserved)
    assert.equal(before?.checksum, migration.checksum)
    assert.equal(metadata.length, definitions.length)
    for (const definition of definitions) {
      const indexes = await f.db.collection(definition.name).listIndexes().toArray()
      for (const index of definition.indexes)
        assert(indexes.some((item) => item.name === index.name))
      if (!['authChallenges', 'refreshRotations'].includes(definition.name))
        assert(indexes.every((item) => item.expireAfterSeconds === undefined))
    }
    await assert.rejects(f.db.collection('ledgerEvents').insertOne({ documentSchemaVersion: 1 }), {
      code: 121,
    })
    await assert.rejects(
      f.db.collection('apiSessions').insertOne({ refreshToken: 'forbidden-plaintext' }),
      { code: 121 },
    )
  },
)

test(
  'migration refuses incompatible indexes, unknown versions and invalid existing data without modifying it',
  integration,
  async (t) => {
    for (const kind of ['index', 'version', 'invalid', 'ttl'] as const) {
      const f = await fixture(false)
      t.after(() => f.client.close())
      if (kind === 'index') {
        await f.db
          .collection('sales')
          .createIndex({ orderId: 1 }, { name: 'sale_order_scope', unique: true })
        await assert.rejects(migrate(f.db), code('INDEX_INCOMPATIBLE'))
      } else if (kind === 'version') {
        await f.db.collection('schemaMigrations').insertOne({
          documentSchemaVersion: 1,
          version: 2,
          checksum: sha256('unknown'),
          appliedAt: new Date(),
        })
        await assert.rejects(migrate(f.db), code('SCHEMA_INCOMPATIBLE'))
      } else if (kind === 'invalid') {
        const original = {
          documentSchemaVersion: 2,
          organizationId: 'historical',
          opaque: 'preserve me',
        }
        await f.db.collection('organizations').insertOne(original)
        await assert.rejects(migrate(f.db), code('INVALID_DOCUMENT'))
        assert.deepEqual(await f.db.collection('organizations').findOne(), original)
      } else {
        await f.db
          .collection('syncReceipts')
          .createIndex({ serverReceivedAt: 1 }, { name: 'unsafe_ttl', expireAfterSeconds: 3600 })
        await assert.rejects(migrate(f.db), code('INDEX_INCOMPATIBLE'))
      }
      assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    }
  },
)

test(
  'concurrent identical events preserve exactly the same receipt and resolve a lost response',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const a = await seed(f.db)
    const b = { ...a }
    await challenge(f.db, b)
    const proof = event(a)
    const results = await Promise.all([
      f.store.persistLedger(a, empty, [proof], validatedForStorage),
      f.store.persistLedger(b, empty, [proof], validatedForStorage),
    ])
    assert.deepEqual(results[0], results[1])
    await challenge(f.db, a)
    const replay = await f.store.persistLedger(a, empty, [proof], validatedForStorage)
    assert.deepEqual(replay, results[0])
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 1)
    assert.equal(await f.db.collection('sales').countDocuments(), 1)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 1)
  },
)

test(
  'duplicate preexisting business identities block index creation without deleting either document',
  integration,
  async (t) => {
    const f = await fixture(false)
    t.after(() => f.client.close())
    const organizationId = randomUUID()
    await f.db.collection('organizations').insertMany([
      { documentSchemaVersion: 1, organizationId, active: true, fence: 0 },
      { documentSchemaVersion: 1, organizationId, active: false, fence: 1 },
    ])
    const before = await f.db.collection('organizations').find().toArray()
    await assert.rejects(migrate(f.db), code('INDEX_INCOMPATIBLE'))
    assert.deepEqual(await f.db.collection('organizations').find().toArray(), before)
    assert.equal(await f.db.collection('schemaMigrations').countDocuments(), 0)
  },
)

test(
  'two concurrent active installations cannot claim one unused chain',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const original = await f.db
      .collection('installations')
      .findOne({ installationId: context.installationId })
    assert(original)
    const { _id: ignored, ...copy } = original
    void ignored
    const chainId = randomUUID()
    await f.db.collection('chains').insertOne({
      documentSchemaVersion: 1,
      organizationId: context.organizationId,
      festivalId: context.festivalId,
      chainId,
      enrollmentGeneration: 1,
      head: empty,
      fence: 0,
    })
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.db
          .collection('installations')
          .insertOne({ ...copy, chainId, installationId: randomUUID(), subject: randomUUID() }),
      ),
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert(results.some((r) => r.status === 'rejected' && r.reason.code === 11000))
    assert.equal(
      await f.db.collection('installations').countDocuments({ chainId, active: true }),
      1,
    )
  },
)

test(
  'restore audit rejects a head referencing missing durable evidence without repairing it',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    await auditEvidence(f.db)
    await f.db
      .collection('chains')
      .updateOne(
        { chainId: context.chainId },
        { $set: { head: { sequence: 1, hash: sha256('missing') } } },
      )
    await assert.rejects(auditEvidence(f.db), code('INVALID_DOCUMENT'))
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 0)
  },
)

test(
  'same event ID with different content and different IDs on the same sequence conflict',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const proof = event(context)
    await f.store.persistLedger(context, empty, [proof], validatedForStorage)
    await challenge(f.db, context)
    await assert.rejects(
      f.store.persistLedger(
        context,
        empty,
        [event(context, 1, null, { id: proof.eventId })],
        validatedForStorage,
      ),
      code('EVENT_CONTENT_CONFLICT'),
    )
    await assert.rejects(
      f.store.persistLedger(context, empty, [event(context)], validatedForStorage),
      code('SEQUENCE_FORK'),
    )
    const nonce = await f.db.collection('authChallenges').findOne({ nonceHash: context.nonceHash })
    assert.equal(nonce?.consumedAt, null, 'failed transaction also rolls back nonce consumption')
  },
)

test(
  'two concurrent different events on one sequence have one winner; independent chains retain separate heads',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const a = await seed(f.db)
    const otherAttempt = { ...a }
    await challenge(f.db, otherAttempt)
    const results = await Promise.allSettled([
      f.store.persistLedger(a, empty, [event(a)], validatedForStorage),
      f.store.persistLedger(otherAttempt, empty, [event(a)], validatedForStorage),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert(results.some((r) => r.status === 'rejected' && code('SEQUENCE_FORK')(r.reason)))
    const b = await seed(f.db, a)
    const next = event(b)
    await f.store.persistLedger(b, empty, [next], validatedForStorage)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 2)
    assert.equal(
      (await f.db.collection('chains').findOne({ chainId: b.chainId }))?.head.hash,
      next.hash,
    )
  },
)

test(
  'failure after partial insertion rolls back events, sales, receipts, challenge and head',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const first = event(context)
    const second = event(context, 2, first.hash)
    await assert.rejects(
      f.store.persistLedger(context, empty, [first, second], async (entry) => {
        if (entry.sequence === 2) throw new PersistenceError('DEPENDENCY_MISSING')
      }),
      code('DEPENDENCY_MISSING'),
    )
    for (const name of ['ledgerEvents', 'sales', 'syncReceipts'])
      assert.equal(await f.db.collection(name).countDocuments(), 0)
    assert.deepEqual(
      (await f.db.collection('chains').findOne({ chainId: context.chainId }))?.head,
      empty,
    )
    assert.equal(
      (await f.db.collection('authChallenges').findOne({ nonceHash: context.nonceHash }))
        ?.consumedAt,
      null,
    )
    await f.store.persistLedger(context, empty, [first, second], validatedForStorage)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 2)
  },
)

test(
  'stale expected head and failed conditional head update never commit partial proofs',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const first = event(context)
    await f.store.persistLedger(context, empty, [first], validatedForStorage)
    await challenge(f.db, context)
    const second = event(context, 2, first.hash)
    await assert.rejects(
      f.store.persistLedger(context, empty, [second], validatedForStorage),
      code('HEAD_MOVED'),
    )
    await assert.rejects(
      f.store.persistLedger(
        context,
        { sequence: 1, hash: first.hash },
        [second],
        async (_entry, { db, session }) => {
          // Simulate another part of a business transaction changing the expected fence.
          await db
            .collection('chains')
            .updateOne({ chainId: context.chainId }, { $inc: { fence: 1 } }, { session })
        },
      ),
      code('HEAD_MOVED'),
    )
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 1)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 1)
  },
)

test(
  'legacy reservations conflict with sealed sales, preserve exact replay and do not advance heads',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    await challenge(f.db, context, 'legacy-import-v1')
    const orderId = randomUUID()
    const proof = {
      eventId: orderId,
      sourceTerminalId: 'test-terminal',
      payloadCanonical: stable({ id: orderId, historical: true }),
      transportFingerprint: '',
    }
    proof.transportFingerprint = fingerprint(
      {
        organizationId: context.organizationId,
        festivalId: context.festivalId,
        chainId: context.chainId,
      },
      proof,
      true,
    )
    const original = await f.store.persistLegacy(context, proof, validatedForStorage)
    await challenge(f.db, context, 'legacy-import-v1')
    assert.deepEqual(await f.store.persistLegacy(context, proof, validatedForStorage), original)
    await challenge(f.db, context)
    await assert.rejects(
      f.store.persistLedger(
        context,
        empty,
        [event(context, 1, null, { orderId })],
        validatedForStorage,
      ),
      code('DUPLICATE_ORDER_OTHER_CHAIN'),
    )
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    assert.deepEqual(
      (await f.db.collection('chains').findOne({ chainId: context.chainId }))?.head,
      empty,
    )
  },
)

test(
  'opaque IDs, both canonicalization profiles, five kinds and historical optional fields remain intact',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const orderId = 'opaque/order:historical'
    const sessionId = 'cash/session:old'
    const forms: Record<string, unknown>[] = [
      { kind: 'sale', orderId, id: 'sale:' + orderId },
      {
        kind: 'correction',
        correction: { operationId: 'refund:old', originalOrderId: orderId, originalSaleHash: null },
      },
      { kind: 'closure', closure: { operationId: 'closure:old' } },
      { kind: 'cash_session_opened', session: { sessionId } },
      { kind: 'cash_float_updated', cashFloatUpdate: { operationId: 'float:old', sessionId } },
    ]
    let previous: string | null = null
    const proofs = forms.map((form, i) => {
      const p = event(context, i + 1, previous, form, i % 2 ? 'android-ledger-v1' : 'ts-ledger-v1')
      previous = p.hash
      return p
    })
    // Correction must reference the stored sealed hash, without adding refundLines.
    forms[1] = {
      kind: 'correction',
      correction: {
        operationId: 'refund:old',
        originalOrderId: orderId,
        originalSaleHash: proofs[0]!.hash,
      },
    }
    previous = null
    const bound = forms.map((form, i) => {
      const p = event(context, i + 1, previous, form, i % 2 ? 'android-ledger-v1' : 'ts-ledger-v1')
      previous = p.hash
      return p
    })
    // Preserve the first proof: changing its generated source identity would change the sale hash.
    assert.equal(bound[0]!.hash, proofs[0]!.hash)
    await f.store.persistLedger(context, empty, bound, validatedForStorage)
    await auditEvidence(f.db)
    const saved = await f.db.collection('ledgerEvents').find().sort({ sequence: 1 }).toArray()
    assert.deepEqual(
      saved.map((e) => e.payloadCanonical),
      bound.map((p) => p.payloadCanonical),
    )
    assert.equal(saved[1]?.payloadCanonical.includes('refundLines'), false)
    assert.equal(saved[2]?.referencedSessionId, undefined)
  },
)

test(
  'logical challenge/session expiry, wrong generation, revoked rights and cross-scope calls are refused',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    await challenge(f.db, context, 'ledger-ingest-v1', new Date(Date.now() - 1000))
    await assert.rejects(
      f.store.persistLedger(context, empty, [event(context)], validatedForStorage),
      code('CHALLENGE_INVALID'),
    )
    await challenge(f.db, context)
    await assert.rejects(
      f.store.persistLedger(
        { ...context, enrollmentGeneration: 2 },
        empty,
        [event(context)],
        validatedForStorage,
      ),
      code('SCOPE_DENIED'),
    )
    await assert.rejects(
      f.store.persistLedger(
        { ...context, festivalId: randomUUID() },
        empty,
        [event(context)],
        validatedForStorage,
      ),
    )
    await f.db
      .collection('apiSessions')
      .updateOne(
        { sessionId: context.sessionId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      )
    await assert.rejects(
      f.store.persistLedger(context, empty, [event(context)], validatedForStorage),
      code('SCOPE_DENIED'),
    )
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 0)
  },
)

test(
  'bootstrap and refresh challenges have distinct persistence shapes and cannot authorize ingestion',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const original = await f.db
      .collection('authChallenges')
      .findOne({ nonceHash: context.nonceHash })
    assert(original)
    const { _id: ignored, ...session } = original
    void ignored
    await f.db
      .collection('authChallenges')
      .insertOne({ ...session, action: 'refresh', nonceHash: sha256(randomUUID()) })
    const pending = {
      documentSchemaVersion: 1,
      purpose: 'enrollment',
      issuer: 'test-pending',
      subject: 'candidate',
      installationId: context.installationId,
      keyFingerprint: context.keyFingerprint,
      nonceHash: sha256(randomUUID()),
      action: 'request',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    }
    await f.db.collection('authChallenges').insertOne({ ...pending })
    const candidate = pending
    await assert.rejects(
      f.db
        .collection('authChallenges')
        .insertOne({ ...candidate, nonceHash: sha256(randomUUID()), action: 'ledger-ingest-v1' }),
      { code: 121 },
    )
    await f.db.collection('authChallenges').insertOne({
      ...candidate,
      nonceHash: sha256(randomUUID()),
      action: 'activate',
      requestId: randomUUID(),
    })
    await assert.rejects(
      f.store.persistLedger(
        { ...context, nonceHash: pending.nonceHash },
        empty,
        [event(context)],
        validatedForStorage,
      ),
      code('CHALLENGE_INVALID'),
    )
  },
)

test(
  'active installation uniqueness and terminal range overlap are enforced transactionally',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const installation = await f.db
      .collection('installations')
      .findOne({ installationId: context.installationId })
    assert(installation)
    const { _id: ignored, ...copy } = installation
    void ignored
    await assert.rejects(
      f.db
        .collection('installations')
        .insertOne({ ...copy, installationId: randomUUID(), subject: randomUUID() }),
      { code: 11000 },
    )
    await assert.rejects(
      transaction(f.client, (session) =>
        f.store.addTerminalRange(
          {
            documentSchemaVersion: 1,
            organizationId: context.organizationId,
            festivalId: context.festivalId,
            chainId: context.chainId,
            firstSequence: 2,
            lastSequence: 5,
            sourceTerminalId: 'replacement',
            evidenceReference: 'test',
          },
          session,
        ),
      ),
      code('TERMINAL_RANGE_CONFLICT'),
    )
    const other = await seed(f.db, context)
    // Test a chain without mappings, then concurrent overlapping ranges with different starts.
    const third = {
      organizationId: context.organizationId,
      festivalId: context.festivalId,
      chainId: randomUUID(),
    }
    await f.db.collection('chains').insertOne({
      documentSchemaVersion: 1,
      ...third,
      enrollmentGeneration: 1,
      head: empty,
      fence: 0,
    })
    const range: TerminalRange = {
      documentSchemaVersion: 1,
      ...third,
      firstSequence: 1,
      lastSequence: 10,
      sourceTerminalId: 'A',
      evidenceReference: 'test',
    }
    const results = await Promise.allSettled([
      transaction(f.client, (s) => f.store.addTerminalRange(range, s)),
      transaction(f.client, (s) =>
        f.store.addTerminalRange(
          { ...range, firstSequence: 5, lastSequence: null, sourceTerminalId: 'B' },
          s,
        ),
      ),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(
      await f.db.collection('terminalRanges').countDocuments({ chainId: third.chainId }),
      1,
    )
    assert(other.chainId !== context.chainId)
  },
)

test(
  'catalog CAS prevents concurrent overwrite, preserves history and respects separate publish capability',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    const scope = { organizationId: context.organizationId, festivalId: context.festivalId }
    const actor = { issuer: 'test-oidc', subject: 'publisher' }
    const version = (revision: number): CatalogVersion => {
      const versionId = randomUUID()
      const publishedAt = new Date()
      const payload = stable({
        ...scope,
        id: versionId,
        revision,
        schemaVersion: 1,
        publishedAt: publishedAt.toISOString(),
        origin: `api:${actor.subject}`,
        products: [],
        categories: [],
      })
      return {
        ...scope,
        documentSchemaVersion: 1,
        versionId,
        revision,
        schemaVersion: 1,
        publishedAt,
        author: actor,
        payload,
        sha256: sha256(payload),
      }
    }
    await assert.rejects(
      f.store.publishCatalog(scope, actor, 0, version(1), () => {}),
      code('SCOPE_DENIED'),
    )
    await f.db.collection('scopeGrants').insertOne({
      documentSchemaVersion: 1,
      ...scope,
      ...actor,
      capability: 'publish_catalog',
      active: true,
      fence: 0,
    })
    const results = await Promise.allSettled([
      f.store.publishCatalog(scope, actor, 0, version(1), () => {}),
      f.store.publishCatalog(scope, actor, 0, version(1), () => {}),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert(results.some((r) => r.status === 'rejected' && code('CATALOG_CONFLICT')(r.reason)))
    const first = await f.db.collection('catalogVersions').findOne()
    await f.store.publishCatalog(scope, actor, 1, version(2), () => {})
    assert.equal(await f.db.collection('catalogVersions').countDocuments(), 2)
    assert.deepEqual(await f.db.collection('catalogVersions').findOne({ revision: 1 }), first)
    assert.equal(
      await f.db.collection('scopeGrants').countDocuments({ capability: 'read_ledger' }),
      0,
    )
  },
)

test('revocation committed before ingestion prevents its commit', integration, async (t) => {
  const f = await fixture()
  t.after(() => f.client.close())
  const context = await seed(f.db)
  const actor = { issuer: 'test-oidc', subject: 'enroller' }
  await f.db.collection('scopeGrants').insertOne({
    documentSchemaVersion: 1,
    organizationId: context.organizationId,
    festivalId: context.festivalId,
    ...actor,
    capability: 'manage_enrollment',
    active: true,
    fence: 0,
  })
  await f.store.revokeInstallation(context, actor)
  await assert.rejects(
    f.store.persistLedger(context, empty, [event(context)], validatedForStorage),
    code('SCOPE_DENIED'),
  )
})

test(
  'real write conflict retries a fresh snapshot with atomic durable result',
  integration,
  async (t) => {
    const f = await fixture()
    t.after(() => f.client.close())
    const context = await seed(f.db)
    let attempts = 0
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let read!: () => void
    const observed = new Promise<void>((resolve) => {
      read = resolve
    })
    const retrying = transaction(f.client, async (session) => {
      attempts++
      await f.db.collection('chains').findOne({ chainId: context.chainId }, { session })
      if (attempts === 1) {
        read()
        await released
      }
      await f.db
        .collection('chains')
        .updateOne({ chainId: context.chainId }, { $inc: { fence: 1 } }, { session })
    })
    await observed
    try {
      await f.db
        .collection('chains')
        .updateOne({ chainId: context.chainId }, { $inc: { fence: 1 } })
    } finally {
      release()
    }
    await retrying
    assert(attempts >= 2)
    assert.equal((await f.db.collection('chains').findOne({ chainId: context.chainId }))?.fence, 2)
  },
)

test(
  'authenticated MongoDB role rejects immutable updates/deletes and standalone activation',
  {
    skip: !process.env.MONGODB_TEST_RBAC_URI
      ? 'RBAC MongoDB integration not executed: MONGODB_TEST_RBAC_URI absent'
      : false,
  },
  async (t) => {
    const target = testTarget()
    const secureUri = process.env.MONGODB_TEST_RBAC_URI!
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27020\/(?:\?.*)?$/.test(secureUri))
      throw new Error('RBAC fixture must be disposable loopback:27020')
    // Docker pre-provisions its disposable account (host publishing is not the
    // MongoDB localhost exception). Native fixtures can bootstrap directly.
    const bootstrap = new MongoClient(secureUri, { timeoutMS: 3000 })
    t.after(() => bootstrap.close())
    const password = process.env.MONGODB_TEST_RBAC_PASSWORD ?? randomUUID() + randomUUID()
    if (!process.env.MONGODB_TEST_RBAC_PASSWORD)
      await bootstrap
        .db('admin')
        .command({ createUser: 'samhain_test_bootstrap', pwd: password, roles: ['root'] })
    const admin = new MongoClient(secureUri, {
      auth: { username: 'samhain_test_bootstrap', password },
      authSource: 'admin',
      timeoutMS: 3000,
    })
    t.after(() => admin.close())
    const db = admin.db(`${target.name}_roles`)
    await assert.rejects(verifyTopology(db), code('TRANSACTIONS_REQUIRED'))
    // Role enforcement itself does not require transactions, so install only the
    // required collections/indexes on this deliberately standalone security fixture.
    for (const definition of definitions)
      await db.createCollection(definition.name, { validator: definition.validator })
    await installRoles(db)
    await installRoles(db)
    await db.command({
      createUser: 'samhain_test_runtime',
      pwd: password,
      roles: [{ role: 'samhain_runtime_v1', db: db.databaseName }],
    })
    const runtime = new MongoClient(secureUri, {
      auth: { username: 'samhain_test_runtime', password },
      authSource: db.databaseName,
      timeoutMS: 3000,
    })
    t.after(() => runtime.close())
    const appDb = runtime.db(db.databaseName)
    await verifyRuntimePrivileges(appDb)
    for (const name of ['ledgerEvents', 'syncReceipts', 'sales', 'catalogVersions']) {
      await assert.rejects(
        appDb.collection(name).updateOne({}, { $set: { documentSchemaVersion: 1 } }),
        { code: 13 },
      )
      await assert.rejects(appDb.collection(name).deleteOne({}), { code: 13 })
    }
    await assert.rejects(appDb.command({ collMod: 'ledgerEvents', validationAction: 'warn' }), {
      code: 13,
    })
    await assert.rejects(verifyRuntimePrivileges(db), code('SCOPE_DENIED'))
  },
)
