import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
import { environment } from './helpers.ts'

test('valid typed configuration and explicit defaults', () => {
  const config = loadConfig(environment)
  assert.equal(config.port, 3000)
  assert.equal(config.mongoTls, false)
  assert.equal(config.poolMax, 10)
  assert.deepEqual(config.corsOrigins, [])
})
for (const [key, value] of Object.entries({
  MONGODB_URI: '',
  MONGODB_DATABASE: '',
  PORT: '65536',
  MONGODB_CONNECT_TIMEOUT_MS: '-1',
  MONGODB_SELECTION_TIMEOUT_MS: '999999',
  NODE_ENV: 'unknown',
  MONGODB_TLS: 'yes',
  MONGODB_POOL_MAX: '0',
  BODY_LIMIT_BYTES: '1048577',
  TRUSTED_PROXIES: 'true',
  READINESS_NETWORKS: '0.0.0.0/0',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'all',
})) {
  test(`refuses invalid ${key} without leaking its value`, () => {
    assert.throws(
      () => loadConfig({ ...environment, [key]: value }),
      /Invalid server configuration/,
    )
  })
}
test('refuses inconsistent limits, production without proxy/probe policy and cross-environment names', () => {
  for (const override of [
    { MONGODB_POOL_MIN: '11' },
    { REQUEST_TIMEOUT_MS: '100' },
    { NODE_ENV: 'production', MONGODB_DATABASE: 'samhain_live', MONGODB_TLS: 'true' },
    { MONGODB_DATABASE: 'samhain_production' },
  ])
    assert.throws(() => loadConfig({ ...environment, ...override }))
})
test('valid production configuration requires TLS, restricted proxies/probes and HTTPS origins', () => {
  const production = {
    ...environment,
    NODE_ENV: 'production',
    MONGODB_DATABASE: 'samhain_live',
    MONGODB_URI: 'mongodb://example-user:example-password@db.example.invalid/',
    MONGODB_TLS: 'true',
    TRUSTED_PROXIES: '10.0.0.2',
    READINESS_NETWORKS: '10.0.1.0/24',
    CORS_ORIGINS: 'https://pos.example.invalid',
  }
  assert.equal(loadConfig(production).environment, 'production')
  assert.throws(() => loadConfig({ ...production, MONGODB_TLS: 'false' }))
  assert.throws(() => loadConfig({ ...production, MONGODB_URI: 'mongodb://db.example.invalid/' }))
  assert.throws(() => loadConfig({ ...production, CORS_ORIGINS: 'http://pos.example.invalid' }))
})
test('rejects insecure MongoDB URI options and sanitizes driver syntax errors', () => {
  for (const option of [
    'tlsAllowInvalidCertificates=true',
    'TLSINSECURE=false',
    'ssl=false',
    'tlsAllowInvalidHostnames=true',
  ]) {
    assert.throws(
      () =>
        loadConfig({
          ...environment,
          MONGODB_URI: `mongodb://user:private-secret@localhost/?${option}`,
        }),
      (error: unknown) => {
        assert(error instanceof Error)
        assert(!error.message.includes('private-secret'))
        return true
      },
    )
  }
  assert.throws(
    () =>
      loadConfig({
        ...environment,
        MONGODB_TLS: 'true',
        MONGODB_URI: 'mongodb://user:private-secret@[]/',
      }),
    /^Error: Invalid server configuration: MONGODB_URI$/,
  )
  assert.throws(() =>
    loadConfig({ ...environment, MONGODB_URI: 'mongodb://remote.example.invalid/' }),
  )
})
