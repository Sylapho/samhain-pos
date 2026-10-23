import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { buildApp } from '../src/app.ts'
import type { AppDependencies } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { config, fakeDatabase, principal, policy } from './helpers.ts'

async function fixture(options: Partial<Config> = {}, dependencies: Partial<AppDependencies> = {}) {
  const database = fakeDatabase()
  const app = await buildApp(
    { ...config(), ...options },
    {
      database,
      apiRoutes: async (api) => {
        api.post(
          '/validate',
          {
            config: { access: policy },
            schema: {
              body: {
                type: 'object',
                required: ['count'],
                additionalProperties: false,
                properties: { count: { type: 'integer', minimum: 1, maximum: 100 } },
              },
            },
          },
          async (request) => ({ body: request.body, raw: request.rawBody?.toString('utf8') }),
        )
        api.get('/secret', { config: { access: policy } }, async () => {
          throw new Error('mongodb://user:secret@private/ token-secret')
        })
        api.get('/large', { config: { access: policy } }, async () => ({
          result: 'x'.repeat(2000),
        }))
        api.get('/ip', { config: { access: policy } }, async (request) => ({
          ip: request.ip,
          protocol: request.protocol,
        }))
        api.get('/slow', { config: { access: policy } }, async (request) => {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { tooLate: true }
        })
        api.get('/forgotten-policy', async () => ({ exposed: true }))
      },
      ...dependencies,
    },
  )
  return { app, database }
}

test('health endpoints are real, bounded, separate from liveness and method-aware', async (t) => {
  const { app, database } = await fixture()
  t.after(() => app.close())
  const live = await app.inject('/health/live')
  assert.equal(live.statusCode, 200)
  assert.deepEqual(live.json(), { status: 'ok' })
  assert.equal(database.checks, 0)
  assert.equal((await app.inject('/health/ready')).statusCode, 200)
  database.available = false
  const unavailable = await app.inject('/health/ready')
  assert.equal(unavailable.statusCode, 503)
  assert.deepEqual(unavailable.json(), { status: 'unavailable' })
  assert.equal(database.checks, 2)
  const wrongMethod = await app.inject({ method: 'POST', url: '/health/live' })
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
  assert.equal((await app.inject('/missing?token=secret')).statusCode, 404)
  assert.equal(
    (await app.inject({ url: '/health/ready', remoteAddress: '192.0.2.1' })).statusCode,
    403,
  )
})
test('readiness timeout aborts in-flight work and future prerequisite failures stay unavailable', async (t) => {
  const database = fakeDatabase()
  let aborted = false
  database.check = async (signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('aborted'))
        },
        { once: true },
      )
    })
  const { app } = await fixture({ readinessTimeoutMs: 100 }, { database })
  t.after(() => app.close())
  const start = performance.now()
  assert.equal((await app.inject('/health/ready')).statusCode, 503)
  assert(performance.now() - start < 1500)
  assert(aborted)
  const second = await fixture(
    {},
    {
      readinessChecks: [
        async () => {
          throw new Error('missing index')
        },
      ],
    },
  )
  t.after(() => second.app.close())
  assert.equal((await second.app.inject('/health/ready')).statusCode, 503)
})
test('deny by default, arbitrary Bearer and self-declared permissions never authenticate', async (t) => {
  const { app } = await fixture()
  t.after(() => app.close())
  for (const headers of [
    {},
    { authorization: 'Bearer invented-token' },
    { 'x-role': 'manager', 'x-permissions': 'read_ledger' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/validate',
      headers,
      payload: { count: 1, permissions: ['read_ledger'] },
    })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: { code: 'AUTH_REQUIRED' } })
  }
  assert.equal((await app.inject('/api/v1/ledger/ingest')).statusCode, 401)
})
test('strict JSON/schema validation never repairs signed bodies', async (t) => {
  const { app } = await fixture({ bodyLimit: 512 }, { authenticate: async () => principal })
  t.after(() => app.close())
  const raw = '{ "count" : 2 }'
  const valid = await app.inject({
    method: 'POST',
    url: '/api/v1/validate',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    payload: raw,
  })
  assert.equal(valid.statusCode, 200)
  assert.deepEqual(valid.json(), { body: { count: 2 }, raw })
  for (const payload of [
    '{',
    '{"count":"2"}',
    '{"count":2,"extra":true}',
    '{}',
    '{"count":0}',
    '{"count":101}',
    '{"count":2,"count":3}',
    '{"count":1.00000000000000001}',
    '{"count":9007199254740992}',
    '{"count":"\\ud800"}',
    '{"count":"\\u0000"}',
    '['.repeat(66) + '0' + ']'.repeat(66),
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/validate',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    assert.equal(response.statusCode, 400, payload)
  }
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/validate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ count: 2, extra: 'x'.repeat(1000) }),
      })
    ).statusCode,
    413,
  )
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/validate',
        headers: { 'content-type': 'text/plain' },
        payload: raw,
      })
    ).statusCode,
    415,
  )
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/validate',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        payload: raw,
      })
    ).statusCode,
    415,
  )
  const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d])
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/validate',
        headers: { 'content-type': 'application/json' },
        payload: invalidUtf8,
      })
    ).statusCode,
    400,
  )
})
test('server-owned identity remains subject to scope and capability authorization', async (t) => {
  const { app } = await fixture(
    {},
    {
      authenticate: async () => ({
        ...principal,
        kind: 'manager',
        subject: 'verified',
        grants: [],
      }),
    },
  )
  t.after(() => app.close())
  assert.equal((await app.inject('/api/v1/secret')).statusCode, 403)
  const second = await fixture({}, { authenticate: async () => principal })
  t.after(() => second.app.close())
  assert.equal((await second.app.inject('/api/v1/forgotten-policy')).statusCode, 401)
})
test('proxy spoofing ignored; production HTTPS requires a trusted immediate peer', async (t) => {
  const { app } = await fixture({}, { authenticate: async () => principal })
  t.after(() => app.close())
  const response = await app.inject({
    url: '/api/v1/ip',
    remoteAddress: '192.0.2.1',
    headers: { 'x-forwarded-for': '10.0.0.2', 'x-forwarded-proto': 'https' },
  })
  assert.deepEqual(response.json(), { ip: '192.0.2.1', protocol: 'http' })
  const prod = await fixture({
    environment: 'production',
    trustedProxies: ['10.0.0.2'],
    readinessNetworks: ['10.0.1.0/24'],
  })
  t.after(() => prod.app.close())
  assert.equal(
    (
      await prod.app.inject({
        url: '/health/live',
        remoteAddress: '192.0.2.1',
        headers: { 'x-forwarded-proto': 'https' },
      })
    ).statusCode,
    400,
  )
  assert.equal(
    (
      await prod.app.inject({
        url: '/health/live',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-proto': 'https' },
      })
    ).statusCode,
    200,
  )
  assert.equal(
    (
      await prod.app.inject({
        url: '/health/ready',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.0.1.5' },
      })
    ).statusCode,
    200,
  )
})
test('CORS restrictive, preflight explicit and quotas enforced', async (t) => {
  const { app } = await fixture({ corsOrigins: ['https://pos.example.invalid'], rateLimit: 3 })
  t.after(() => app.close())
  assert.equal(
    (await app.inject({ url: '/health/live', headers: { origin: 'https://evil.example.invalid' } }))
      .statusCode,
    403,
  )
  const allowed = await app.inject({
    url: '/health/live',
    headers: { origin: 'https://pos.example.invalid' },
  })
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://pos.example.invalid')
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/v1/anything',
    headers: { origin: 'https://pos.example.invalid', 'access-control-request-method': 'POST' },
  })
  assert.equal(preflight.statusCode, 204)
  const limited = await app.inject('/health/live')
  assert.equal(limited.statusCode, 429)
  assert.deepEqual(limited.json(), { error: { code: 'RATE_LIMITED' } })
  assert(limited.headers['retry-after'])
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/secret',
          remoteAddress: '127.0.0.2',
          headers: { authorization: 'Bearer invented-token' },
        })
      ).statusCode,
      401,
    )
  }
  assert.equal(
    (await app.inject({ url: '/api/v1/secret', remoteAddress: '127.0.0.2' })).statusCode,
    429,
  )
})
test('errors and logs leak no secrets; IDs generated server-side; responses bounded', async (t) => {
  let logs = ''
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString()
      done()
    },
  })
  const { app } = await fixture(
    { logLevel: 'info', responseLimit: 512 },
    { authenticate: async () => principal, logStream: stream },
  )
  t.after(() => app.close())
  const response = await app.inject({
    url: '/api/v1/secret?token=query-secret',
    headers: {
      authorization: 'Bearer token-secret',
      cookie: 'cookie-secret',
      'x-request-id': 'untrusted-id',
    },
  })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: { code: 'INTERNAL_ERROR' } })
  assert.match(String(response.headers['x-request-id']), /^[a-f\d-]{36}$/)
  assert(response.headers['x-content-type-options'])
  assert.equal((await app.inject('/api/v1/large')).statusCode, 500)
  for (const secret of [
    'mongodb://',
    'private',
    'token-secret',
    'query-secret',
    'cookie-secret',
    'untrusted-id',
  ]) {
    assert(!logs.includes(secret), secret)
    assert(!response.body.includes(secret), secret)
  }
  const events = logs
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert(
    events.some(
      (event) => event.reqId === response.headers['x-request-id'] && event.statusCode === 500,
    ),
  )
})
test('handler deadline returns controlled error and aborts asynchronous work', async (t) => {
  const { app } = await fixture({ requestTimeoutMs: 100 }, { authenticate: async () => principal })
  t.after(() => app.close())
  const response = await app.inject('/api/v1/slow')
  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { error: { code: 'SERVER_UNAVAILABLE' } })
})
