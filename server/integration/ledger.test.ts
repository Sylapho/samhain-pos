import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MongoClient, MongoNetworkError } from 'mongodb'
import { authFixture, candidate } from './auth-fixture.ts'
import {
  ledger,
  wire,
  head,
  order,
  correction,
  closure,
  legacy,
  recordedAt,
} from '../tests/ledger-fixtures.ts'
import type { LedgerProof } from '../src/persistence/proofs.ts'
import type { Head, LedgerEvent, SyncReceipt } from '../src/persistence/model.ts'
import { ApiError } from '../src/errors.ts'
import { createAuthService } from '../src/tablet-auth/service.ts'
import { buildApp } from '../src/app.ts'
import { config, fakeDatabase } from '../tests/helpers.ts'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const integration = {
  skip: !process.env.MONGODB_TEST_URI
    ? 'MongoDB integration not executed: MONGODB_TEST_URI absent'
    : false,
}
const empty = { sequence: 0, hash: null }
async function setup(t: TestContext, legacyOrderIds: string[] = []) {
  const f = await authFixture()
  t.after(() => f.close())
  const scope = await f.scope(),
    tablet = candidate(f, undefined, { legacyOrderIds })
  const enrolled = await tablet.enroll(scope)
  const token = enrolled.session.access_token
  const context = {
    protocolVersion: 1,
    ...scope,
    chainId: tablet.chainId,
    installationId: tablet.installationId,
    enrollmentGeneration: enrolled.enrollmentGeneration,
  }
  const body = (events: LedgerProof[], expectedHead: Head = empty) => ({
    ...context,
    requestId: randomUUID(),
    expectedHead,
    events: events.map(wire),
  })
  const ingest = (events: LedgerProof[], expectedHead: Head = empty) =>
    tablet.signed('/api/v1/ledger/ingest', 'ledger-ingest-v1', body(events, expectedHead), token)
  const send = (endpoint: 'legacy' | 'prefix', events: unknown[]) =>
    tablet.signed(
      `/api/v1/ledger/${endpoint}`,
      endpoint === 'legacy' ? 'legacy-import-v1' : 'ledger-prefix-v1',
      { ...context, requestId: randomUUID(), events },
      token,
    )
  return { ...f, scopeValue: scope, tablet, token, context, body, ingest, send }
}
function failure(response: { statusCode: number; json(): unknown }, status: number, code: string) {
  assert.equal(response.statusCode, status, JSON.stringify(response.json()))
  const value = response.json() as {
    error: { code: string }
    acknowledgements?: unknown
    committed?: unknown
  }
  assert.equal(value.error.code, code)
  assert(!('acknowledgements' in value) && !('committed' in value))
}

test(
  'HTTP: all five kinds, both profiles, durable original bytes, stable receipts and lost ACK replay',
  integration,
  async (t) => {
    const f = await setup(t)
    const opening = ledger(
      f.context,
      'cash_session_opened',
      {
        sessionId: 'session/opaque',
        periodStart: '2026-10-24T09:00:00.000Z',
        openingFloatCents: 300,
        createdAt: '2026-10-24T09:00:00.000Z',
      },
      empty,
      'android-ledger-v1',
      { recordedAt: '2026-10-24T09:00:00.000Z' },
    )
    const update = ledger(
      f.context,
      'cash_float_updated',
      {
        operationId: 'float/1',
        sessionId: 'session/opaque',
        previousOpeningFloatCents: 300,
        newOpeningFloatCents: 350,
        updatedAt: recordedAt,
      },
      head(opening),
    )
    const sale = ledger(f.context, 'sale', order(), head(update), 'android-ledger-v1')
    const refund = ledger(f.context, 'correction', correction(sale), head(sale))
    const close = ledger(
      f.context,
      'closure',
      closure({
        periodStart: '2026-10-24T09:00:00.000Z',
        cashSessionId: 'session/opaque',
        openingFloatCents: 350,
        theoreticalCashCents: 451,
        totals: {
          saleCount: 1,
          grossSalesCents: 202,
          correctionCount: 1,
          correctionTotalCents: -101,
          netTotalCents: 101,
          cumulativeNetTotalCents: 101,
          paymentTotalsCents: { cash: 101, card: 0 },
        },
      }),
      head(refund),
      'android-ledger-v1',
      { recordedAt: '2026-10-24T11:00:00.000Z' },
    )
    const batch = [opening, update, sale, refund, close]
    const result = await f.ingest(batch)
    assert.equal(result.statusCode, 200, result.body)
    const first = result.json()
    assert.equal(result.headers['x-samhain-destination'], f.configuration.destinationId)
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        'protocolVersion',
        'requestId',
        'organizationId',
        'festivalId',
        'chainId',
        'committed',
        'serverHead',
        'acknowledgements',
      ].sort(),
    )
    for (const receipt of first.acknowledgements)
      assert.deepEqual(
        Object.keys(receipt).sort(),
        [
          'eventId',
          'sequence',
          'hash',
          'transportFingerprint',
          'receiptId',
          'serverReceivedAt',
          'status',
        ].sort(),
      )
    assert.equal(first.committed, true)
    assert.deepEqual(first.serverHead, head(close))
    assert.deepEqual(
      first.acknowledgements.map((r: { status: string }) => r.status),
      Array(5).fill('accepted'),
    )
    // A response lost by the client is recovered by fresh proof + identical financial content.
    const replay = await f.ingest(batch)
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(
      replay.json().acknowledgements,
      first.acknowledgements.map((r: object) => ({ ...r, status: 'already_present' })),
    )
    assert.equal(await f.db.collection('sales').countDocuments(), 1)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 5)
    const stored = await f.db
      .collection<LedgerEvent>('ledgerEvents')
      .find()
      .sort({ sequence: 1 })
      .toArray()
    assert.deepEqual(
      stored.map((e) => e.payloadCanonical),
      batch.map((e) => e.payloadCanonical),
    )
    assert(!('refundLines' in JSON.parse(stored[3]!.payloadCanonical).correction))
  },
)

test(
  'HTTP: identical/divergent concurrent requests, same ID conflict and sequence forks',
  integration,
  async (t) => {
    const f = await setup(t),
      event = ledger(f.context)
    const responses = await Promise.all([f.ingest([event]), f.ingest([event])])
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [200, 200],
      responses.map((r) => r.body).join('\n'),
    )
    assert.deepEqual(responses.map((r) => r.json().acknowledgements[0].status).sort(), [
      'accepted',
      'already_present',
    ])
    assert.equal(
      responses[0]!.json().acknowledgements[0].receiptId,
      responses[1]!.json().acknowledgements[0].receiptId,
    )
    const original = JSON.parse(event.payloadCanonical).order
    failure(
      await f.ingest([
        ledger(f.context, 'sale', {
          ...original,
          items: [{ ...original.items[0], note: 'different' }],
        }),
      ]),
      409,
      'EVENT_CONTENT_CONFLICT',
    )
    failure(await f.ingest([ledger(f.context)]), 409, 'SEQUENCE_FORK')
    const a = ledger(f.context, 'sale', order(), head(event)),
      b = ledger(f.context, 'sale', order(), head(event))
    const divergent = await Promise.all([f.ingest([a], head(event)), f.ingest([b], head(event))])
    assert.deepEqual(divergent.map((r) => r.statusCode).sort(), [200, 409])
    failure(
      divergent.find((r) => r.statusCode === 409)!,
      409,
      'SEQUENCE_FORK',
    )
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 2)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 2)
  },
)

test(
  'HTTP: mixed replay suffix, stale head, missing predecessor and previousHash',
  integration,
  async (t) => {
    const f = await setup(t),
      first = ledger(f.context)
    assert.equal((await f.ingest([first])).statusCode, 200)
    const second = ledger(f.context, 'sale', order(), head(first))
    const reusedIdAfterGap = ledger(
      f.context,
      'sale',
      order(),
      { sequence: 3, hash: second.hash },
      undefined,
      { id: first.eventId },
    )
    failure(await f.ingest([second, reusedIdAfterGap], head(first)), 409, 'EVENT_CONTENT_CONFLICT')
    const gap = ledger(f.context, 'sale', order(), { sequence: 2, hash: second.hash })
    failure(await f.ingest([first, gap]), 409, 'MISSING_PREDECESSOR')
    failure(await f.ingest([first, second]), 409, 'HEAD_MOVED')
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 1)
    const mixed = await f.ingest([first, second], head(first))
    assert.equal(mixed.statusCode, 200, mixed.body)
    assert.deepEqual(
      mixed.json().acknowledgements.map((r: { status: string }) => r.status),
      ['already_present', 'accepted'],
    )
    failure(
      await f.ingest(
        [ledger(f.context, 'sale', order(), { sequence: 3, hash: second.hash })],
        head(second),
      ),
      409,
      'MISSING_PREDECESSOR',
    )
    failure(
      await f.ingest(
        [ledger(f.context, 'sale', order(), { sequence: 2, hash: '0'.repeat(64) })],
        head(second),
      ),
      409,
      'SEQUENCE_FORK',
    )
  },
)

test(
  'HTTP: two real enrolled tablets, scope isolation and order uniqueness across chains',
  integration,
  async (t) => {
    const f = await setup(t),
      b = candidate(f),
      enrolled = await b.enroll(f.scopeValue)
    const shared = order(),
      a = ledger(f.context, 'sale', shared)
    const otherContext = {
      ...f.context,
      chainId: b.chainId,
      installationId: b.installationId,
      enrollmentGeneration: enrolled.enrollmentGeneration,
    }
    const other = ledger(otherContext)
    const result = await Promise.all([
      f.ingest([a]),
      b.signed(
        '/api/v1/ledger/ingest',
        'ledger-ingest-v1',
        { ...otherContext, requestId: randomUUID(), expectedHead: empty, events: [wire(other)] },
        enrolled.session.access_token,
      ),
    ])
    assert.deepEqual(
      result.map((r) => r.statusCode),
      [200, 200],
      result.map((r) => r.body).join('\n'),
    )
    const duplicate = ledger(otherContext, 'sale', shared, head(other))
    failure(
      await b.signed(
        '/api/v1/ledger/ingest',
        'ledger-ingest-v1',
        {
          ...otherContext,
          requestId: randomUUID(),
          expectedHead: head(other),
          events: [wire(duplicate)],
        },
        enrolled.session.access_token,
      ),
      409,
      'DUPLICATE_ORDER_OTHER_CHAIN',
    )
    for (const change of [
      { organizationId: randomUUID() },
      { festivalId: randomUUID() },
      { chainId: b.chainId },
      { installationId: b.installationId },
      { enrollmentGeneration: 99 },
    ]) {
      const response = await f.tablet.signed(
        '/api/v1/ledger/prefix',
        'ledger-prefix-v1',
        { ...f.context, ...change, requestId: randomUUID(), events: [] },
        f.token,
      )
      failure(
        response,
        403,
        'enrollmentGeneration' in change ? 'INSTALLATION_RETIRED' : 'SCOPE_DENIED',
      )
    }
    assert.equal(await f.db.collection('sales').countDocuments(), 2)
  },
)

test(
  'HTTP: dependencies/closure/float failures roll back ALL financial writes and nonce consumption',
  integration,
  async (t) => {
    const f = await setup(t),
      sale = ledger(f.context)
    const missing = ledger(
      f.context,
      'correction',
      correction(sale, { originalOrderId: 'missing' }),
      head(sale),
    )
    const wrongReference = ledger(
      f.context,
      'correction',
      correction(sale, { originalSaleHash: '0'.repeat(64) }),
      head(sale),
    )
    failure(await f.ingest([sale, wrongReference]), 422, 'BUSINESS_INCONSISTENCY')
    const value = f.body([sale, missing]),
      p = await f.tablet.proof('ledger-ingest-v1', value)
    const nonceBefore = await f.db.collection('authChallenges').countDocuments({ consumedAt: null })
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/ledger/ingest',
      payload: p.raw,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${f.token}`,
        'x-samhain-nonce': p.nonce,
        'x-samhain-signature': p.signature,
      },
    })
    failure(response, 409, 'DEPENDENCY_MISSING')
    for (const name of ['sales', 'ledgerEvents', 'syncReceipts'])
      assert.equal(await f.db.collection(name).countDocuments(), 0)
    assert.deepEqual((await f.db.collection('chains').findOne())!.head, empty)
    assert.equal(
      await f.db.collection('authChallenges').countDocuments({ consumedAt: null }),
      nonceBefore,
    )
    const badClose = ledger(
      f.context,
      'closure',
      closure({ totals: { ...closure().totals, grossSalesCents: 999 } }),
      head(sale),
      undefined,
      { recordedAt: '2026-10-24T11:00:00.000Z' },
    )
    failure(await f.ingest([sale, badClose]), 422, 'BUSINESS_INCONSISTENCY')
    const update = ledger(f.context, 'cash_float_updated', {
      operationId: 'float',
      sessionId: 'missing',
      previousOpeningFloatCents: 0,
      newOpeningFloatCents: 1,
      updatedAt: recordedAt,
    })
    failure(await f.ingest([update]), 409, 'DEPENDENCY_MISSING')
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
  },
)

test(
  'HTTP: historical closures and structured refunds use original prices and cumulative VAT',
  integration,
  async (t) => {
    const f = await setup(t),
      sale = ledger(f.context)
    const line = {
      originalLineId: 'line/1',
      productId: 'test/1',
      productName: 'Test',
      quantity: 1,
      unitPriceCents: 101,
      vatRate: 10,
      grossCents: 101,
      vatCents: 9,
    }
    const refund = ledger(
      f.context,
      'correction',
      correction(sale, { refundLines: [line] }),
      head(sale),
    )
    assert.equal((await f.ingest([sale, refund])).statusCode, 200)
    const over = ledger(
      f.context,
      'correction',
      correction(sale, {
        amountDeltaCents: -202,
        refundLines: [{ ...line, quantity: 2, grossCents: 202, vatCents: 18 }],
      }),
      head(refund),
    )
    failure(await f.ingest([over], head(refund)), 422, 'BUSINESS_INCONSISTENCY')
    const closing = ledger(
      f.context,
      'closure',
      closure({
        totals: {
          saleCount: 1,
          grossSalesCents: 202,
          correctionCount: 1,
          correctionTotalCents: -101,
          netTotalCents: 101,
          cumulativeNetTotalCents: 101,
          paymentTotalsCents: { cash: 101, card: 0 },
        },
      }),
      head(refund),
      undefined,
      { recordedAt: '2026-10-24T11:00:00.000Z' },
    )
    const response = await f.ingest([closing], head(refund))
    assert.equal(response.statusCode, 200, response.body)
    const persisted = await f.db.collection('ledgerEvents').findOne({ eventId: closing.eventId })
    assert(!('cashSessionId' in JSON.parse(String(persisted!.payloadCanonical)).closure))
  },
)

test(
  'HTTP: atomic authorized legacy batches, exact snapshots, replay and sealed collisions',
  integration,
  async (t) => {
    const a = order(),
      b = order(),
      unknown = order()
    const f = await setup(t, [a.id, b.id])
    failure(
      await f.send('legacy', [legacy(f.context, a), legacy(f.context, unknown)]),
      403,
      'SCOPE_DENIED',
    )
    assert.equal(await f.db.collection('sales').countDocuments(), 0)
    assert.equal(await f.db.collection('syncReceipts').countDocuments(), 0)
    const response = await f.send('legacy', [legacy(f.context, a), legacy(f.context, b)])
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().serverHead, empty)
    assert(
      response
        .json()
        .acknowledgements.every(
          (r: { sequence: null; hash: null }) => r.sequence === null && r.hash === null,
        ),
    )
    const replay = await f.send('legacy', [legacy(f.context, a), legacy(f.context, b)])
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(
      replay.json().acknowledgements,
      response.json().acknowledgements.map((r: object) => ({ ...r, status: 'already_present' })),
    )
    const stored = await f.db.collection('sales').findOne({ orderId: a.id })
    assert.equal(stored!.payloadCanonical, legacy(f.context, a).payloadCanonical)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    failure(await f.ingest([ledger(f.context, 'sale', a)]), 409, 'DUPLICATE_ORDER_OTHER_CHAIN')
    // An imported unsealed sale can be referenced without fabricating a financial hash.
    const dummy = ledger(f.context, 'sale', a)
    const refund = ledger(f.context, 'correction', correction(dummy, { originalSaleHash: null }))
    assert.equal((await f.ingest([refund])).statusCode, 200)
  },
)

test(
  'HTTP: prefix tuples match/absent/conflict, no ACK, recovery diagnostic and revoked access',
  integration,
  async (t) => {
    const f = await setup(t),
      first = ledger(f.context)
    assert.equal((await f.ingest([first])).statusCode, 200)
    const tuple = {
      sequence: first.sequence,
      eventId: first.eventId,
      hash: first.hash,
      transportFingerprint: first.transportFingerprint,
    }
    for (const [events, status] of [
      [[tuple], 'match'],
      [[{ ...tuple, eventId: 'other' }], 'conflict'],
      [[{ ...tuple, sequence: 2 }], 'absent'],
    ] as const) {
      const response = await f.send('prefix', [...events])
      assert.equal(response.statusCode, 200, response.body)
      const body = response.json()
      assert.equal(body.results[0].status, status)
      assert(!('acknowledgements' in body) && !('committed' in body))
      if (status === 'conflict') assert.deepEqual(body.results[0].server, tuple)
      else assert(!('server' in body.results[0]))
    }
    await f.db
      .collection('installations')
      .updateOne(
        { installationId: f.tablet.installationId },
        { $set: { authorization: 'needs_recovery' } },
      )
    assert.equal((await f.send('prefix', [])).statusCode, 200)
    failure(await f.ingest([first]), 403, 'ACCESS_REVOKED')
    const revoked = await f.service.revoke(
      f.manager,
      f.tablet.installationId,
      { ...f.context, operationRequestId: randomUUID() },
      Buffer.from('{}'),
    )
    assert.equal(revoked.status, 'revoked')
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 1)
  },
)

test(
  'HTTP: nonce replay, invalid signature, altered raw bytes, expired nonce/session and size limits',
  integration,
  async (t) => {
    const f = await setup(t),
      first = ledger(f.context),
      value = f.body([first]),
      p = await f.tablet.proof('ledger-ingest-v1', value)
    const inject = (raw = p.raw, signature = p.signature, nonce = p.nonce) =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/ledger/ingest',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${f.token}`,
          'x-samhain-nonce': nonce,
          'x-samhain-signature': signature,
        },
      })
    for (const [change, code] of [
      [
        {
          hash: '0'.repeat(64),
          payloadCanonical: first.payloadCanonical.replace(first.hash, '0'.repeat(64)),
        },
        'INVALID_HASH',
      ],
      [{ transportFingerprint: '0'.repeat(64) }, 'INVALID_FINGERPRINT'],
    ] as const) {
      const invalid = { ...value, events: [{ ...wire(first), ...change }] }
      failure(
        await f.tablet.signed('/api/v1/ledger/ingest', 'ledger-ingest-v1', invalid, f.token),
        422,
        code,
      )
    }
    failure(await inject(p.raw, 'A'.repeat(p.signature.length)), 403, 'ACCESS_REVOKED')
    failure(await inject(Buffer.concat([p.raw, Buffer.from(' ')])), 403, 'ACCESS_REVOKED')
    assert.equal((await inject()).statusCode, 200)
    failure(await inject(), 403, 'ACCESS_REVOKED')
    const expired = await f.tablet.proof('ledger-ingest-v1', value)
    await f.db
      .collection('authChallenges')
      .updateMany({ consumedAt: null }, { $set: { expiresAt: new Date(0) } })
    failure(await inject(expired.raw, expired.signature, expired.nonce), 403, 'ACCESS_REVOKED')
    const large = await f.app.inject({
      method: 'POST',
      url: '/api/v1/ledger/ingest',
      payload: ' '.repeat(1048577),
      headers: { 'content-type': 'application/json' },
    })
    failure(large, 413, 'BATCH_TOO_LARGE')
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/v1/ledger/ingest',
      payload: '{"requestId":"x","x":1,"x":2}',
      headers: { 'content-type': 'application/json' },
    })
    failure(invalid, 422, 'INVALID_PAYLOAD')
    const sessionProof = await f.tablet.proof('ledger-ingest-v1', value)
    await f.db.collection('apiSessions').updateMany({}, { $set: { expiresAt: new Date(0) } })
    failure(
      await inject(sessionProof.raw, sessionProof.signature, sessionProof.nonce),
      401,
      'AUTH_REQUIRED',
    )
  },
)

test(
  'HTTP: real rollback before commit, unknown commit outcome and recovery from durable receipts',
  integration,
  async (t) => {
    const f = await setup(t),
      first = ledger(f.context)
    const original = f.client.startSession.bind(f.client)
    let attempts = 0
    f.client.startSession = (...args) => {
      const session = original(...args)
      session.commitTransaction = async () => {
        attempts++
        throw new ApiError(503, 'SERVER_UNAVAILABLE')
      }
      return session
    }
    // The challenge has to be created before faulting transaction commits (challenge issuance itself is not transactional).
    failure(await f.ingest([first]), 503, 'SERVER_UNAVAILABLE')
    assert.equal(attempts, 1)
    for (const name of ['sales', 'ledgerEvents', 'syncReceipts'])
      assert.equal(await f.db.collection(name).countDocuments(), 0)
    assert.deepEqual((await f.db.collection('chains').findOne())!.head, empty)
    attempts = 0
    f.client.startSession = (...args) => {
      const session = original(...args),
        commit = session.commitTransaction.bind(session)
      session.commitTransaction = async () => {
        attempts++
        await commit()
        const error = new MongoNetworkError('test lost response')
        error.addErrorLabel('UnknownTransactionCommitResult')
        throw error
      }
      return session
    }
    failure(await f.ingest([first]), 503, 'TRANSACTION_RETRY')
    assert.equal(attempts, 3)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 1)
    const receipt = await f.db.collection<SyncReceipt>('syncReceipts').findOne()
    f.client.startSession = original
    const response = await f.ingest([first])
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().acknowledgements[0].receiptId, receipt!.receiptId)
    assert.equal(response.json().acknowledgements[0].status, 'already_present')
    attempts = 0
    f.client.startSession = (...args) => {
      const session = original(...args),
        commit = session.commitTransaction.bind(session)
      session.commitTransaction = async () => {
        attempts++
        await commit()
        if (attempts === 1) {
          const error = new MongoNetworkError('test lost first commit response')
          error.addErrorLabel('UnknownTransactionCommitResult')
          throw error
        }
      }
      return session
    }
    const second = ledger(f.context, 'sale', order(), head(first))
    const confirmed = await f.ingest([second], head(first))
    f.client.startSession = original
    assert.equal(confirmed.statusCode, 200, confirmed.body)
    assert.equal(attempts, 2)
    assert.equal(confirmed.json().acknowledgements[0].status, 'accepted')
  },
)

test(
  'HTTP: revocation concurrent with ingestion serializes, no post-revocation upload or diagnostic',
  integration,
  async (t) => {
    const f = await setup(t),
      event = ledger(f.context),
      value = f.body([event])
    const p = await f.tablet.proof('ledger-ingest-v1', value)
    const prefixValue = { ...f.context, requestId: randomUUID(), events: [] }
    const prefixProof = await f.tablet.proof('ledger-prefix-v1', prefixValue)
    const inject = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/ledger/ingest',
        payload: p.raw,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${f.token}`,
          'x-samhain-nonce': p.nonce,
          'x-samhain-signature': p.signature,
        },
      })
    const [ingested] = await Promise.all([
      inject(),
      f.service.revoke(
        f.manager,
        f.tablet.installationId,
        { ...f.context, operationRequestId: randomUUID() },
        Buffer.from('{}'),
      ),
    ])
    assert([200, 403].includes(ingested.statusCode), ingested.body)
    const count = ingested.statusCode === 200 ? 1 : 0
    for (const name of ['sales', 'ledgerEvents', 'syncReceipts'])
      assert.equal(await f.db.collection(name).countDocuments(), count)
    failure(await inject(), 403, 'ACCESS_REVOKED')
    const prefix = await f.app.inject({
      method: 'POST',
      url: '/api/v1/ledger/prefix',
      payload: prefixProof.raw,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${f.token}`,
        'x-samhain-nonce': prefixProof.nonce,
        'x-samhain-signature': prefixProof.signature,
      },
    })
    failure(prefix, 403, 'ACCESS_REVOKED')
  },
)

test(
  'HTTP: unreachable MongoDB fails within its budget, no financial ACK or mutation',
  integration,
  async (t) => {
    const f = await setup(t),
      value = f.body([ledger(f.context)]),
      p = await f.tablet.proof('ledger-ingest-v1', value)
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    )
    const client = new MongoClient(
      'mongodb://127.0.0.1:' + address.port + '/?directConnection=true',
      { serverSelectionTimeoutMS: 150, connectTimeoutMS: 150, timeoutMS: 300 },
    )
    t.after(() => client.close())
    const db = client.db(f.db.databaseName)
    const service = createAuthService(client, db, f.configuration, f.service.crypto)
    const app = await buildApp(config(), {
      database: { ...fakeDatabase(), mongo: { client, db } },
      authService: service,
    })
    t.after(() => app.close())
    const start = performance.now()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ledger/ingest',
      payload: p.raw,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + f.token,
        'x-samhain-nonce': p.nonce,
        'x-samhain-signature': p.signature,
      },
    })
    failure(response, 503, 'SERVER_UNAVAILABLE')
    assert(performance.now() - start < 3000)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
  },
)

test(
  'HTTP: deadline cancels the transaction before commit and preserves pending financial data',
  integration,
  async (t) => {
    const f = await setup(t),
      value = f.body([ledger(f.context)]),
      p = await f.tablet.proof('ledger-ingest-v1', value)
    const protectedTablet = f.service.protectedTablet
    f.service.protectedTablet = (token, action, proof, work, recovery, signal) =>
      protectedTablet(
        token,
        action,
        proof,
        async (state, session) => {
          await delay(200)
          return work(state, session)
        },
        recovery,
        signal,
      )
    const app = await buildApp(
      { ...config(), requestTimeoutMs: 100 },
      {
        database: { ...fakeDatabase(), mongo: { client: f.client, db: f.db } },
        authService: f.service,
      },
    )
    t.after(() => app.close())
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ledger/ingest',
      payload: p.raw,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + f.token,
        'x-samhain-nonce': p.nonce,
        'x-samhain-signature': p.signature,
      },
    })
    failure(response, 503, 'SERVER_UNAVAILABLE')
    await delay(300)
    f.service.protectedTablet = protectedTablet
    for (const name of ['ledgerEvents', 'sales', 'syncReceipts'])
      assert.equal(await f.db.collection(name).countDocuments(), 0)
    assert.deepEqual((await f.db.collection('chains').findOne())!.head, empty)
  },
)
