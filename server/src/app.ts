import Fastify, { LogController } from 'fastify'
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'
import type { Config } from './config.ts'
import type { Database } from './database.ts'
import { authorize, denyAuthentication } from './auth.ts'
import type { AccessPolicy, Authenticator } from './auth.ts'
import { ApiError, errorResponse } from './errors.ts'
import { parseStrictJson } from './json.ts'
import { networkMatcher } from './network.ts'
import { authCrypto } from './tablet-auth/crypto.ts'
import { createAuthService } from './tablet-auth/service.ts'
import { authRoutes } from './tablet-auth/routes.ts'
import type { AuthService } from './tablet-auth/service.ts'
import { PersistenceError } from './persistence/errors.ts'
import { ledgerRoutes } from './ledger/routes.ts'
import { syncError } from './ledger/errors.ts'

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: AccessPolicy
  }
  interface FastifyRequest {
    rawBody: Buffer | null
  }
}

export type AppDependencies = {
  database: Database
  authenticate?: Authenticator
  apiRoutes?: FastifyPluginAsync
  // Additional read-only prerequisites share the probe budget with Database.check.
  readinessChecks?: readonly ((signal: AbortSignal) => Promise<void>)[]
  logStream?: Writable
  authService?: AuthService
}

export async function buildApp(
  config: Config,
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const trustProxy = networkMatcher(config.trustedProxies)
  const probeAllowed = networkMatcher(config.readinessNetworks)
  const app = Fastify({
    logger: {
      level: config.logLevel,
      stream: dependencies.logStream ?? process.stdout,
      // Allowlist serializers also protect Fastify's own diagnostic calls.
      serializers: {
        req: (req) => ({ method: req.method }),
        res: (res) => ({ statusCode: res.statusCode }),
        err: () => ({
          type: 'Error',
          message: 'INTERNAL_ERROR',
          stack: '',
          code: 'INTERNAL_ERROR',
        }),
      },
      redact: ['req.headers', 'req.body', 'authorization', 'cookie', 'mongoUri'],
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy,
    bodyLimit: config.bodyLimit,
    requestTimeout: config.requestTimeoutMs,
    handlerTimeout: config.requestTimeoutMs,
    connectionTimeout: config.requestTimeoutMs,
    keepAliveTimeout: 5000,
    return503OnClosing: true,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  })
  app.server.headersTimeout = config.requestTimeoutMs
  app.decorateRequest('rawBody', null)
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    try {
      if (
        !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
          request.headers['content-type'] ?? '',
        )
      )
        return done(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE'))
      const buffer = body as Buffer
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
      request.rawBody = buffer
      done(null, parseStrictJson(text))
    } catch {
      done(new ApiError(400, 'INVALID_PAYLOAD'))
    }
  })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    let status = 500
    let code = 'INTERNAL_ERROR'
    if (error instanceof ApiError) {
      status = error.status
      code = error.code
    } else if (error instanceof PersistenceError) {
      status = 503
      code = 'TRANSACTION_RETRY'
    } else if (error.validation) {
      status = 400
      code = 'INVALID_ENVELOPE'
    } else {
      const known: Record<string, [number, string]> = {
        FST_ERR_CTP_BODY_TOO_LARGE: [413, 'BATCH_TOO_LARGE'],
        FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE'],
        FST_ERR_CTP_INVALID_CONTENT_LENGTH: [400, 'INVALID_PAYLOAD'],
        FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'INVALID_PAYLOAD'],
        FST_ERR_HOOK_TIMEOUT: [503, 'SERVER_UNAVAILABLE'],
        FST_ERR_HANDLER_TIMEOUT: [503, 'SERVER_UNAVAILABLE'],
      }
      const mapped = known[error.code ?? '']
      if (mapped) [status, code] = mapped
    }
    request.log[status >= 500 ? 'error' : 'warn']({ code }, 'request_failed')
    if (status === 503) reply.header('Retry-After', '1')
    if (request.url.split('?')[0]?.startsWith('/api/v1/ledger/')) {
      const financial = syncError(code, status, request.body)
      void reply.code(financial.status).send(financial.body)
    } else void reply.code(status).send(errorResponse(code))
  })
  // Do not include raw URLs, query strings, bodies, headers or arbitrary exception messages.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request_completed',
    )
  })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id).header('Cache-Control', 'no-store')
    if (config.environment === 'production' && request.protocol !== 'https')
      throw new ApiError(400, 'HTTPS_REQUIRED')
    if (request.headers['content-encoding'] !== undefined)
      throw new ApiError(415, 'UNSUPPORTED_CONTENT_ENCODING')
  })
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimit,
    timeWindow: 60000,
    cache: 10000,
    errorResponseBuilder: () => new ApiError(429, 'RATE_LIMITED'),
  })
  // Run before CORS/auth, including rejected credentials, preflights and unmatched paths.
  app.addHook('onRequest', app.rateLimit())
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) return callback(null, false)
      if (!config.corsOrigins.includes(origin))
        return callback(new ApiError(403, 'ORIGIN_DENIED'), false)
      callback(null, true)
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Samhain-Nonce', 'X-Samhain-Signature'],
    exposedHeaders: ['X-Request-ID', 'X-Samhain-Destination'],
    credentials: false,
    maxAge: 300,
    strictPreflight: true,
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (payload === null || payload === undefined) return payload
    // v1 responses must be buffered JSON. Reject streams before sending any bytes.
    if (
      !(typeof payload === 'string' || Buffer.isBuffer(payload)) ||
      Buffer.byteLength(payload) > config.responseLimit
    ) {
      const financial = request.url.split('?')[0]?.startsWith('/api/v1/ledger/')
      reply.code(financial ? 503 : 500).type('application/json')
      reply.removeHeader('content-length')
      return JSON.stringify(
        financial
          ? syncError('SERVER_UNAVAILABLE', 503, request.body).body
          : errorResponse('RESPONSE_TOO_LARGE'),
      )
    }
    return payload
  })

  app.get('/health/live', { exposeHeadRoute: false }, async () => ({ status: 'ok' }))
  app.get('/health/ready', { exposeHeadRoute: false }, async (request, reply) => {
    if (!probeAllowed(request.ip)) throw new ApiError(403, 'SCOPE_DENIED')
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        (async () => {
          await dependencies.database.check(controller.signal)
          for (const check of dependencies.readinessChecks ?? []) await check(controller.signal)
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error('Readiness timeout'))
          }, config.readinessTimeoutMs)
        }),
      ])
      return { status: 'ready' }
    } catch {
      request.log.warn({ code: 'SERVER_UNAVAILABLE' }, 'readiness_failed')
      reply.code(503).header('Retry-After', '1')
      return { status: 'unavailable' }
    } finally {
      clearTimeout(timeout)
    }
  })
  // Catch method mismatches explicitly; GET must not silently expose automatic HEAD routes.
  for (const path of ['/health/live', '/health/ready']) {
    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      url: path,
      handler: async (_request, reply) => {
        reply.header('Allow', 'GET')
        throw new ApiError(405, 'METHOD_NOT_ALLOWED')
      },
    })
  }
  const authService =
    dependencies.authService ??
    (config.auth && dependencies.database.mongo
      ? createAuthService(
          dependencies.database.mongo.client,
          dependencies.database.mongo.db,
          config.auth,
          await authCrypto(config.auth),
        )
      : null)
  // Bootstrap routes verify possession themselves; manager/tablet handlers also perform
  // cryptographic and transactional authorization. Other API routes remain deny-by-default.
  if (authService) await app.register(authRoutes(authService), { prefix: '/api/v1' })
  if (authService && dependencies.database.mongo)
    await app.register(
      ledgerRoutes(dependencies.database.mongo.client, dependencies.database.mongo.db, authService),
      { prefix: '/api/v1' },
    )
  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request) => {
        const policy = request.routeOptions.config.access
        // No policy means closed, including newly added or unmatched business routes.
        if (!policy) throw new ApiError(401, 'AUTH_REQUIRED')
        authorize(await (dependencies.authenticate ?? denyAuthentication)(request), policy)
      })
      if (dependencies.apiRoutes) await api.register(dependencies.apiRoutes)
      api.setNotFoundHandler(async () => {
        throw new ApiError(404, 'NOT_FOUND')
      })
    },
    { prefix: '/api/v1' },
  )
  app.setNotFoundHandler(async () => {
    throw new ApiError(404, 'NOT_FOUND')
  })
  return app
}
