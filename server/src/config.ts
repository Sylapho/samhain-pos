import { MongoClient } from 'mongodb'
import { isIP } from 'node:net'
import { networkMatcher } from './network.ts'

export type Config = {
  environment: 'test' | 'development' | 'production'
  host: string
  port: number
  mongoUri: string
  mongoDatabase: string
  mongoTls: boolean
  poolMin: number
  poolMax: number
  connectTimeoutMs: number
  selectionTimeoutMs: number
  socketTimeoutMs: number
  operationTimeoutMs: number
  readinessTimeoutMs: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  bodyLimit: number
  responseLimit: number
  rateLimit: number
  trustedProxies: string[]
  readinessNetworks: string[]
  corsOrigins: string[]
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

export class ConfigurationError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fail = (key: string): never => {
    throw new ConfigurationError(`Invalid server configuration: ${key}`)
  }
  const required = (key: string): string => env[key]?.trim() || fail(key)
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = env[key] ?? String(fallback)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail(key)
    const number = Number(value)
    return number >= min && number <= max ? number : fail(key)
  }
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = env[key] ?? String(fallback)
    if (value !== 'true' && value !== 'false') return fail(key)
    return value === 'true'
  }
  const csv = (key: string): string[] => {
    if (!env[key]) return []
    const values = env[key]!.split(',').map((v) => v.trim())
    if (values.some((v) => !v)) fail(key)
    return values
  }
  const networks = (key: string): string[] => {
    const values = csv(key)
    try {
      networkMatcher(values)
    } catch {
      fail(key)
    }
    // An explicit allowlist must never mean every possible peer.
    if (values.some((v) => v.endsWith('/0'))) fail(key)
    return values
  }
  const environment = required('NODE_ENV')
  if (!['test', 'development', 'production'].includes(environment)) fail('NODE_ENV')
  const production = environment === 'production'
  const mongoUri = required('MONGODB_URI')
  const mongoDatabase = required('MONGODB_DATABASE')
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(mongoDatabase)) fail('MONGODB_DATABASE')
  if (environment === 'test' && !/^samhain_test_[a-z0-9_]+$/.test(mongoDatabase))
    fail('MONGODB_DATABASE: test namespace required')
  if (production && /(?:^|_)(test|dev|local)(?:_|$)/i.test(mongoDatabase))
    fail('MONGODB_DATABASE: production namespace required')
  // Reject insecure aliases even when options passed to the driver would override them.
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) fail('MONGODB_URI')
  const query = new URLSearchParams(mongoUri.split('?')[1] ?? '')
  for (const [key, value] of query) {
    const normalized = key.toLowerCase()
    if (
      ['tlsinsecure', 'tlsallowinvalidcertificates', 'tlsallowinvalidhostnames'].includes(
        normalized,
      )
    )
      fail('MONGODB_URI: insecure TLS option')
    if (['tls', 'ssl'].includes(normalized) && value.toLowerCase() !== 'true')
      fail('MONGODB_URI: TLS cannot be disabled in URI')
  }
  const mongoTls = boolean('MONGODB_TLS', true)
  if (
    !mongoTls &&
    (production || !/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//.test(mongoUri))
  )
    fail('MONGODB_TLS: plaintext only allowed on local test/development database')
  try {
    // Syntax validation only: constructing a client performs no I/O.
    const parsed = new MongoClient(mongoUri, { tls: mongoTls })
    if (production && !parsed.options.credentials)
      fail('MONGODB_URI: authenticated account required')
  } catch {
    fail('MONGODB_URI')
  }
  const trustedProxies = networks('TRUSTED_PROXIES')
  const readinessNetworks = networks('READINESS_NETWORKS')
  if (production && (!trustedProxies.length || !readinessNetworks.length))
    fail('TRUSTED_PROXIES / READINESS_NETWORKS required in production')
  const corsOrigins = csv('CORS_ORIGINS')
  for (const origin of corsOrigins) {
    try {
      const parsed = new URL(origin)
      if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol))
        fail('CORS_ORIGINS')
      if (production && parsed.protocol !== 'https:') fail('CORS_ORIGINS')
    } catch {
      fail('CORS_ORIGINS')
    }
  }
  const logLevel = env.LOG_LEVEL ?? 'info'
  if (!['silent', 'error', 'warn', 'info', 'debug'].includes(logLevel)) fail('LOG_LEVEL')
  const host = env.HOST ?? '127.0.0.1'
  if (!isIP(host)) fail('HOST')
  const config: Config = {
    environment: environment as Config['environment'],
    host,
    port: integer('PORT', 3000, 1, 65535),
    mongoUri,
    mongoDatabase,
    mongoTls,
    poolMin: integer('MONGODB_POOL_MIN', 0, 0, 50),
    poolMax: integer('MONGODB_POOL_MAX', 10, 1, 100),
    connectTimeoutMs: integer('MONGODB_CONNECT_TIMEOUT_MS', 3000, 100, 10000),
    selectionTimeoutMs: integer('MONGODB_SELECTION_TIMEOUT_MS', 3000, 100, 10000),
    socketTimeoutMs: integer('MONGODB_SOCKET_TIMEOUT_MS', 5000, 100, 15000),
    operationTimeoutMs: integer('MONGODB_OPERATION_TIMEOUT_MS', 5000, 100, 15000),
    readinessTimeoutMs: integer('READINESS_TIMEOUT_MS', 2000, 100, 5000),
    requestTimeoutMs: integer('REQUEST_TIMEOUT_MS', 25000, 100, 25000),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 10000, 100, 30000),
    bodyLimit: integer('BODY_LIMIT_BYTES', 1048576, 256, 1048576),
    responseLimit: integer('RESPONSE_LIMIT_BYTES', 1048576, 256, 1048576),
    rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120, 1, 10000),
    trustedProxies,
    readinessNetworks: readinessNetworks.length ? readinessNetworks : ['127.0.0.1', '::1'],
    corsOrigins,
    logLevel: logLevel as Config['logLevel'],
  }
  if (config.poolMin > config.poolMax) fail('MONGODB_POOL_MIN / MONGODB_POOL_MAX')
  if (Math.max(config.operationTimeoutMs, config.readinessTimeoutMs) >= config.requestTimeoutMs)
    fail('MongoDB and readiness timeouts must be smaller than REQUEST_TIMEOUT_MS')
  return config
}
