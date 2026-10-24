import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { authFixture, candidate } from './auth-fixture.ts'
import { digest } from '../src/tablet-auth/crypto.ts'
import type { SessionReply } from '../src/tablet-auth/types.ts'
import { migrate, migrations, stable } from '../src/persistence/migrations.ts'
import { definitions as baseline } from '../src/persistence/schema-v1.ts'
import { fixture } from './fixture.ts'

const integration = {
  skip: !process.env.MONGODB_TEST_URI
    ? 'MongoDB integration not executed: MONGODB_TEST_URI absent'
    : false,
}
test(
  'auth migration is additive over #131 and preserves its checksum and financial evidence',
  integration,
  async (t) => {
    const f = await fixture(false)
    t.after(() => f.client.close())
    for (const definition of baseline) {
      await f.db.createCollection(definition.name, {
        validator: definition.validator,
        validationLevel: 'strict',
        validationAction: 'error',
        collation: { locale: 'simple' },
      })
      await f.db.collection(definition.name).createIndexes(definition.indexes)
    }
    await f.db
      .collection('schemaMigrations')
      .insertOne({ documentSchemaVersion: 1, ...migrations[0], appliedAt: new Date() })
    const before = await f.db.collection('schemaMigrations').findOne()
    await migrate(f.db)
    await migrate(f.db)
    assert.deepEqual(await f.db.collection('schemaMigrations').findOne({ version: 1 }), before)
    assert.equal(await f.db.collection('schemaMigrations').countDocuments(), 2)
    for (const name of ['ledgerEvents', 'sales', 'syncReceipts', 'chains', 'catalogVersions'])
      assert.equal(await f.db.collection(name).countDocuments(), 0)
  },
)
test(
  'two installations enroll with scoped manager rights and no unapproved financial access',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const s = await f.scope()
    const a = candidate(f)
    const b = candidate(f)
    const pending = await a.request()
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/tablet-enrollments/${pending.requestId}/decision`,
          payload: {
            ...s,
            chainId: a.chainId,
            operationRequestId: randomUUID(),
            decision: 'approve',
          },
        })
      ).statusCode,
      401,
    )
    const first = await a.enroll(s)
    const second = await b.enroll(s)
    assert.equal(first.status, 'authorized')
    assert.equal(second.status, 'authorized')
    assert.notEqual(first.session.access_token, second.session.access_token)
    assert.equal(
      (
        await a.signed(
          '/api/v1/tablets/status',
          'status',
          { installationId: a.installationId },
          first.session.access_token,
        )
      ).statusCode,
      200,
    )
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    const stored = await f.db
      .collection('apiSessions')
      .findOne({ installationId: a.installationId })
    assert(stored)
    assert.equal(stored.refreshHash, digest(first.session.refresh_token))
    assert(!stable(stored).includes(first.session.refresh_token))
  },
)
test(
  'proofs reject nonce reuse, altered action/bytes, identity substitution and public-key replacement',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const a = candidate(f)
    const b = candidate(f)
    const proof = await a.proof('request', a.body)
    const send = (raw = proof.raw, signature = proof.signature) =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/tablet-enrollments',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-samhain-nonce': proof.nonce,
          'x-samhain-signature': signature,
        },
      })
    assert.equal((await send(Buffer.from(proof.raw.toString() + ' '))).statusCode, 403)
    assert.equal((await send()).statusCode, 200)
    assert.equal((await send()).statusCode, 403)
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/auth/challenges',
          payload: { installationId: a.installationId, action: 'request', publicKey: b.publicKey },
        })
      ).statusCode,
      403,
    )
    const expired = await a.proof('request', a.body)
    await f.db
      .collection('authChallenges')
      .updateOne({ nonceHash: digest(expired.nonce) }, { $set: { expiresAt: new Date(0) } })
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/tablet-enrollments',
          payload: expired.raw,
          headers: {
            'content-type': 'application/json',
            'x-samhain-nonce': expired.nonce,
            'x-samhain-signature': expired.signature,
          },
        })
      ).statusCode,
      403,
    )
  },
)
test(
  'rejection is visible through candidate proof and invitations enforce five persisted failures',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const s = await f.scope()
    const rejected = candidate(f)
    const r = await rejected.request()
    assert.equal((await rejected.decision(r.requestId, s, 'reject')).statusCode, 200)
    const status = await rejected.signed(
      '/api/v1/tablets/status',
      'status',
      { installationId: rejected.installationId, requestId: r.requestId },
      undefined,
      r.requestId,
    )
    assert.equal(status.json<{ status: string }>().status, 'rejected')
    const a = candidate(f)
    const pending = await a.request()
    assert.equal((await a.decision(pending.requestId, s)).statusCode, 200)
    for (let i = 0; i < 5; i++) {
      const response = await a.signed(
        `/api/v1/tablet-enrollments/${pending.requestId}/activate`,
        'activate',
        {
          installationId: a.installationId,
          operationRequestId: randomUUID(),
          invitationCode: 'wrong',
        },
        undefined,
        pending.requestId,
      )
      assert.equal(response.statusCode, 403)
    }
    assert.equal(
      (await f.db.collection('enrollmentRequests').findOne({ requestId: pending.requestId }))
        ?.attempts,
      5,
    )
    assert.equal(await f.db.collection('apiSessions').countDocuments(), 0)
  },
)
test(
  'refresh rotates atomically, exact concurrent retry returns one response and replay revokes its family',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const s = await f.scope()
    const a = candidate(f)
    const active = await a.enroll(s)
    const body = {
      installationId: a.installationId,
      refresh_token: active.session.refresh_token,
      rotationId: randomUUID(),
    }
    const responses = await Promise.all([
      a.signed('/api/v1/auth/refresh', 'refresh', body),
      a.signed('/api/v1/auth/refresh', 'refresh', body),
    ])
    assert(
      responses.every((r) => r.statusCode === 200),
      responses.map((r) => r.body).join('\n'),
    )
    assert.deepEqual(responses[0]!.json(), responses[1]!.json())
    const preRevocationProof = await a.proof('status', { installationId: a.installationId })
    const replay = await a.signed('/api/v1/auth/refresh', 'refresh', {
      ...body,
      rotationId: randomUUID(),
    })
    assert.equal(replay.statusCode, 409)
    assert.equal(replay.json<{ error: { code: string } }>().error.code, 'REFRESH_REPLAY')
    assert.equal(await f.db.collection('apiSessions').countDocuments({ active: true }), 0)
    const current = responses[0]!.json<SessionReply>()
    await assert.rejects(
      f.service.protectedTablet(
        current.access_token,
        'status',
        preRevocationProof,
        async () => null,
      ),
    )
  },
)
test(
  'revocation rejects a still-valid JWT and exact activation recovery cannot resurrect a revoked session',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const s = await f.scope()
    const a = candidate(f)
    const active = await a.enroll(s)
    const body = { ...s, chainId: a.chainId, operationRequestId: randomUUID() }
    const revoke = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/tablets/${a.installationId}/revoke`,
        headers: { authorization: `Bearer ${f.manager}` },
        payload: body,
      })
    const first = await revoke()
    const second = await revoke()
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json(), second.json())
    // A valid cryptographic JWT no longer grants an operation after the registry commit.
    const nonce = { nonce: 'a'.repeat(43), signature: 'invalid', raw: Buffer.from('{}') }
    await assert.rejects(
      f.service.protectedTablet(active.session.access_token, 'status', nonce, async () => null),
    )
    const activation = await a.signed(
      `/api/v1/tablet-enrollments/${active.requestId}/activate`,
      'activate',
      active.activationBody,
      undefined,
      active.requestId,
    )
    assert.equal(activation.statusCode, 409)
  },
)
test(
  'scope isolation, independent capabilities and expiry are checked live',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const one = await f.scope()
    const two = await f.scope()
    const a = candidate(f)
    const pending = await a.request()
    assert.equal((await a.decision(pending.requestId, one)).statusCode, 200)
    assert.equal(
      (
        await f.app.inject({
          method: 'GET',
          url: `/api/v1/tablet-enrollments/${pending.requestId}?organizationId=${two.organizationId}&festivalId=${two.festivalId}`,
          headers: { authorization: `Bearer ${f.manager}` },
        })
      ).statusCode,
      404,
    )
    await f.db
      .collection('scopeGrants')
      .updateOne({ ...one, capability: 'manage_enrollment' }, { $set: { active: false } })
    assert.equal((await a.decision(pending.requestId, one)).statusCode, 403)
    assert.equal(
      await f.db.collection('scopeGrants').countDocuments({ capability: 'read_ledger' }),
      0,
    )
    assert.equal(
      await f.db.collection('scopeGrants').countDocuments({ capability: 'publish_catalog' }),
      0,
    )
  },
)
test(
  'replacement preserves chain, retires the previous generation and refuses divergence',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const s = await f.scope()
    const old = candidate(f)
    await old.enroll(s)
    const replacement = candidate(f, old.chainId, { restored: true })
    const active = await replacement.enroll(s, old.installationId)
    assert.equal(active.status, 'authorized')
    assert.equal(active.enrollmentGeneration, 2)
    assert.equal(
      (await f.db.collection('installations').findOne({ installationId: old.installationId }))
        ?.active,
      false,
    )
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
    const other = candidate(f, old.chainId)
    const alreadyRetired = await f.app.inject({
      method: 'POST',
      url: `/api/v1/tablets/${old.installationId}/revoke`,
      headers: { authorization: `Bearer ${f.manager}` },
      payload: { ...s, chainId: old.chainId, operationRequestId: randomUUID() },
    })
    assert.equal(alreadyRetired.statusCode, 200)
    assert.equal(
      (
        await f.db
          .collection('installations')
          .findOne({ installationId: replacement.installationId })
      )?.active,
      true,
    )
    const request = await other.request()
    assert.equal(
      (await other.decision(request.requestId, s, 'approve', old.installationId)).statusCode,
      409,
    )
    await f.db
      .collection('chains')
      .updateOne(
        { chainId: old.chainId },
        { $set: { head: { sequence: 1, hash: 'a'.repeat(64) } } },
      )
    const archive = candidate(f, old.chainId, { restored: true })
    const recovery = await archive.enroll(s, replacement.installationId)
    assert.equal(recovery.status, 'needs_recovery')
  },
)

test(
  'two approved replacements race on the pinned generation with exactly one winner',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const first = candidate(f)
    await first.enroll(scope)
    const contenders = [
      candidate(f, first.chainId, { restored: true }),
      candidate(f, first.chainId, { restored: true }),
    ]
    const activations = []
    for (const contender of contenders) {
      const requested = await contender.request()
      const decision = await contender.decision(
        requested.requestId,
        scope,
        'approve',
        first.installationId,
      )
      assert.equal(decision.statusCode, 200, decision.body)
      activations.push({
        contender,
        requested,
        code: decision.json<{ invitationCode: string }>().invitationCode,
      })
    }
    const results = await Promise.all(
      activations.map(({ contender, requested, code }) =>
        contender.signed(
          `/api/v1/tablet-enrollments/${requested.requestId}/activate`,
          'activate',
          {
            installationId: contender.installationId,
            operationRequestId: randomUUID(),
            invitationCode: code,
          },
          undefined,
          requested.requestId,
        ),
      ),
    )
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409])
    assert.equal(
      await f.db
        .collection('installations')
        .countDocuments({ chainId: first.chainId, active: true }),
      1,
    )
    assert.equal(
      await f.db.collection('apiSessions').countDocuments({ chainId: first.chainId, active: true }),
      1,
    )
  },
)

test(
  'expired refresh recovery is refused; replay after TTL cleanup still invalidates the family',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    const enrolled = await a.enroll(scope)
    const body = {
      installationId: a.installationId,
      rotationId: randomUUID(),
      refresh_token: enrolled.session.refresh_token,
    }
    assert.equal((await a.signed('/api/v1/auth/refresh', 'refresh', body)).statusCode, 200)
    await f.db
      .collection('refreshRotations')
      .updateOne({ rotationId: body.rotationId }, { $set: { expiresAt: new Date(0) } })
    assert.equal((await a.signed('/api/v1/auth/refresh', 'refresh', body)).statusCode, 409)
    await f.db.collection('refreshRotations').deleteMany({ rotationId: body.rotationId })
    const replay = await a.signed('/api/v1/auth/refresh', 'refresh', {
      ...body,
      rotationId: randomUUID(),
    })
    assert.equal(replay.statusCode, 409)
    assert.equal(await f.db.collection('apiSessions').countDocuments({ active: true }), 0)
  },
)

test(
  'logical invitation/session expiry and withdrawn approver rights do not depend on TTL cleanup',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    const request = await a.request()
    const decision = await a.decision(request.requestId, scope)
    const body = {
      installationId: a.installationId,
      operationRequestId: randomUUID(),
      invitationCode: decision.json<{ invitationCode: string }>().invitationCode,
    }
    const activate = () =>
      a.signed(
        `/api/v1/tablet-enrollments/${request.requestId}/activate`,
        'activate',
        body,
        undefined,
        request.requestId,
      )
    await f.db
      .collection('scopeGrants')
      .updateOne({ ...scope, capability: 'manage_enrollment' }, { $set: { active: false } })
    assert.equal((await activate()).statusCode, 403)
    await f.db
      .collection('scopeGrants')
      .updateOne({ ...scope, capability: 'manage_enrollment' }, { $set: { active: true } })
    await f.db
      .collection('enrollmentRequests')
      .updateOne({ requestId: request.requestId }, { $set: { invitationExpiresAt: new Date(0) } })
    assert.equal((await activate()).statusCode, 410)
    assert.equal(await f.db.collection('apiSessions').countDocuments(), 0)
    const b = candidate(f)
    const active = await b.enroll(scope)
    const proof = await b.proof('status', { installationId: b.installationId })
    await f.db
      .collection('apiSessions')
      .updateOne({ installationId: b.installationId }, { $set: { expiresAt: new Date(0) } })
    let called = false
    await assert.rejects(
      f.service.protectedTablet(active.session.access_token, 'status', proof, async () => {
        called = true
      }),
    )
    assert.equal(called, false)
  },
)

test(
  'a committed revoke fences a protected write prepared with a valid JWT and fresh proof',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    const active = await a.enroll(scope)
    const proof = await a.proof('status', { installationId: a.installationId })
    const revoked = await f.app.inject({
      method: 'POST',
      url: `/api/v1/tablets/${a.installationId}/revoke`,
      headers: { authorization: `Bearer ${f.manager}` },
      payload: { ...scope, chainId: a.chainId, operationRequestId: randomUUID() },
    })
    assert.equal(revoked.statusCode, 200)
    let wrote = false
    await assert.rejects(
      f.service.protectedTablet(active.session.access_token, 'status', proof, async () => {
        wrote = true
      }),
    )
    assert.equal(wrote, false)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
  },
)

test(
  'OIDC configuration is public metadata and absent configuration fails administrative calls closed',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const response = await f.app.inject('/api/v1/auth/oidc-config')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json<{ scopes: string[] }>().scopes, ['openid', 'test-api'])
    assert.equal(response.headers['x-samhain-destination'], f.configuration.destinationId)
    f.configuration.oidc = null
    assert.equal((await f.app.inject('/api/v1/auth/oidc-config')).statusCode, 503)
    assert.equal(
      (
        await f.app.inject({
          url: '/api/v1/auth/manager',
          headers: { authorization: `Bearer ${f.manager}` },
        })
      ).statusCode,
      503,
    )
  },
)

test(
  'invitation storage is hash-only and a lost approval needs an explicit new decision',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    const requested = await a.request()
    const body = {
      ...scope,
      chainId: a.chainId,
      decision: 'approve',
      operationRequestId: randomUUID(),
    }
    const decide = (value: typeof body) =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/tablet-enrollments/${requested.requestId}/decision`,
        headers: { authorization: `Bearer ${f.manager}` },
        payload: value,
      })
    const first = await decide(body)
    assert.equal(first.statusCode, 200)
    const secret = first.json<{ invitationCode: string }>().invitationCode
    const persisted = await f.db
      .collection('enrollmentRequests')
      .findOne({ requestId: requested.requestId })
    assert(persisted)
    assert.equal(persisted.invitationHash, digest(secret))
    assert(!stable(persisted).includes(secret))
    assert(!Object.keys(persisted).some((key) => key.includes('Ciphertext')))
    const retry = await decide(body)
    assert.equal(retry.statusCode, 409)
    assert.equal(retry.json<{ error: { code: string } }>().error.code, 'INVITATION_UNAVAILABLE')
    const renewed = await decide({ ...body, operationRequestId: randomUUID() })
    assert.equal(renewed.statusCode, 200)
    assert.notEqual(renewed.json<{ invitationCode: string }>().invitationCode, secret)
  },
)

test(
  'an old revoke retry never revokes a later explicitly reenrolled generation',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f)
    await a.enroll(scope)
    const body = { ...scope, chainId: a.chainId, operationRequestId: randomUUID() }
    const revoke = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/tablets/${a.installationId}/revoke`,
        headers: { authorization: `Bearer ${f.manager}` },
        payload: body,
      })
    const first = await revoke()
    assert.equal(first.statusCode, 200)
    a.body.operationRequestId = randomUUID()
    const reactivated = await a.enroll(scope)
    assert.equal(reactivated.enrollmentGeneration, 2)
    const replay = await revoke()
    assert.equal(replay.statusCode, 200)
    assert.deepEqual(replay.json(), first.json())
    assert.equal(
      (await f.db.collection('installations').findOne({ installationId: a.installationId }))
        ?.active,
      true,
    )
    assert.equal(
      await f.db
        .collection('apiSessions')
        .countDocuments({ installationId: a.installationId, active: true }),
      1,
    )
  },
)
