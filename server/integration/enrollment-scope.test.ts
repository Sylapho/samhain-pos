import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { authFixture, candidate } from './auth-fixture.ts'
import { migrate, migrations } from '../src/persistence/migrations.ts'
import { definitions as v2 } from '../src/persistence/schema-v2.ts'

const integration = {
  skip: !process.env.MONGODB_TEST_URI ? 'Disposable MongoDB fixture absent' : false,
}

test(
  'requested scope is durable, immutable, isolated and requires explicit scoped approval',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const other = await f.scope()
    const a = candidate(f)
    const body = { ...a.body, ...scope }
    for (const invalid of [
      { ...body, organizationId: '' },
      { ...body, festivalId: 'bad' },
      { ...a.body, organizationId: scope.organizationId },
    ]) {
      assert.equal(
        (await a.signed('/api/v1/tablet-enrollments', 'request', invalid)).statusCode,
        400,
      )
    }
    const send = (value = body) => a.signed('/api/v1/tablet-enrollments', 'request', value)
    const pending = await send()
    assert.equal(pending.statusCode, 200, pending.body)
    const { requestId } = pending.json<{ requestId: string }>()
    assert.equal((await send()).json<{ requestId: string }>().requestId, requestId)
    assert.equal((await send({ ...body, festivalId: other.festivalId })).statusCode, 409)
    assert.equal(
      (await send({ ...body, operationRequestId: randomUUID(), ...other })).statusCode,
      409,
    )
    assert.deepEqual(
      (await f.db.collection('enrollmentRequests').findOne({ requestId }))?.requestedScope,
      scope,
    )
    const detail = (s = scope, token = f.manager) =>
      f.app.inject({
        method: 'GET',
        url: `/api/v1/tablet-enrollments/${requestId}?organizationId=${s.organizationId}&festivalId=${s.festivalId}`,
        headers: { authorization: `Bearer ${token}` },
      })
    assert.equal((await detail(other)).statusCode, 404)
    assert.deepEqual((await detail()).json<{ requestedScope: unknown }>().requestedScope, scope)
    const list = await f.app.inject({
      method: 'GET',
      url: `/api/v1/tablet-enrollments?organizationId=${scope.organizationId}&festivalId=${scope.festivalId}`,
      headers: { authorization: `Bearer ${f.manager}` },
    })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json<{ items: { requestId: string }[] }>().items[0]?.requestId, requestId)
    assert.equal((await a.decision(requestId, other)).statusCode, 404)
    const unauthorized = await f.managerToken('unauthorized')
    assert.equal((await detail(scope, unauthorized)).statusCode, 403)
    const decision = (s = scope, token = unauthorized) =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/tablet-enrollments/${requestId}/decision`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ...s,
          chainId: a.chainId,
          operationRequestId: randomUUID(),
          decision: 'approve',
        },
      })
    assert.equal((await decision()).statusCode, 403)
    for (const collection of ['organizations', 'festivals']) {
      const filter =
        collection === 'organizations' ? { organizationId: scope.organizationId } : scope
      await f.db.collection(collection).updateOne(filter, { $set: { active: false } })
      assert.equal((await a.decision(requestId, scope)).statusCode, 403)
      await f.db.collection(collection).updateOne(filter, { $set: { active: true } })
    }
    assert.equal(
      (await decision({ ...scope, festivalId: randomUUID() }, f.manager)).statusCode,
      403,
    )
    assert.equal(
      (await decision({ ...scope, festivalId: other.festivalId }, f.manager)).statusCode,
      403,
    )
    assert.equal(await f.db.collection('apiSessions').countDocuments(), 0)
    const approved = await a.decision(requestId, scope)
    assert.equal(approved.statusCode, 200, approved.body)
    const active = await a.signed(
      `/api/v1/tablet-enrollments/${requestId}/activate`,
      'activate',
      {
        installationId: a.installationId,
        operationRequestId: randomUUID(),
        invitationCode: approved.json<{ invitationCode: string }>().invitationCode,
      },
      undefined,
      requestId,
    )
    assert.equal(active.statusCode, 200, active.body)
    assert.equal(active.json<{ organizationId: string }>().organizationId, scope.organizationId)
    assert.equal(
      await f.db
        .collection('scopeGrants')
        .countDocuments({ capability: { $in: ['read_ledger', 'publish_catalog'] } }),
      0,
    )
  },
)

test(
  'scope migration preserves v2 checksums, existing requests and legacy approval',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    const pending = await a.request()
    const before = await f.db
      .collection('enrollmentRequests')
      .findOne({ requestId: pending.requestId })
    // Reproduce the previous manifest on this uniquely named disposable database only.
    const definition = v2.find((entry) => entry.name === 'enrollmentRequests')!
    await f.db.command({ collMod: 'enrollmentRequests', validator: definition.validator })
    await f.db.collection('schemaMigrations').deleteOne({ version: 3 })
    const previous = await f.db.collection('schemaMigrations').findOne({ version: 2 })
    assert.equal(previous?.checksum, migrations[1]!.checksum)
    await migrate(f.db)
    await migrate(f.db)
    assert.deepEqual(await f.db.collection('schemaMigrations').findOne({ version: 2 }), previous)
    assert.deepEqual(
      await f.db.collection('enrollmentRequests').findOne({ requestId: pending.requestId }),
      before,
    )
    assert.equal((await a.decision(pending.requestId, scope)).statusCode, 200)
  },
)
