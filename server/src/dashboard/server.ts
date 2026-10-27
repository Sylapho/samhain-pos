import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Db, Document, FindCursor } from 'mongodb'
import type { Festival, LedgerEvent, Sale } from '../persistence/model.ts'
import { dataset, report, salesCsv } from './report.ts'
import type { Filters } from './report.ts'
import type { Dataset } from './types.ts'

const limit = 50_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
async function readRows<T extends Document & { payloadCanonical: string }>(
  cursor: FindCursor<T>,
  budget: { bytes: number },
): Promise<T[]> {
  const rows: T[] = []
  try {
    for await (const row of cursor) {
      budget.bytes += Buffer.byteLength(row.payloadCanonical)
      if (rows.length >= limit || budget.bytes > 64 * 1024 * 1024) throw new Error('LIMIT')
      rows.push(row)
    }
    return rows
  } finally {
    await cursor.close()
  }
}
export function queryFilters(q: Record<string, string | undefined>): Filters {
  if (Object.values(q).some((v) => typeof v !== 'string' && v !== undefined))
    throw new Error('FILTER')
  for (const value of [q.from, q.to])
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new Error('FILTER')
  if (
    (q.from && q.to && q.from > q.to) ||
    (q.payment && !['cash', 'card'].includes(q.payment)) ||
    (q.terminal?.length ?? 0) > 512 ||
    (q.search?.length ?? 0) > 120
  )
    throw new Error('FILTER')
  return {
    from: q.from ?? '',
    to: q.to ?? '',
    terminal: q.terminal ?? '',
    payment: q.payment ?? '',
    search: q.search ?? '',
  }
}

export async function dashboardApp(
  db: Db,
  port: number,
  dist = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url)),
  options: { publicOrigin?: string } = {},
) {
  const publicOrigin = options.publicOrigin
  const hosts = publicOrigin
    ? [new URL(publicOrigin).host]
    : [`127.0.0.1:${port}`, `localhost:${port}`]
  const origins = publicOrigin ? [publicOrigin] : hosts.map((host) => `http://${host}`)
  const app = Fastify({ logger: false, requestTimeout: 20000, bodyLimit: 1024 })
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: publicOrigin ? [] : null,
      },
    },
    strictTransportSecurity: publicOrigin ? { maxAge: 31536000 } : false,
  })
  if (publicOrigin)
    await app.register(rateLimit, {
      max: 240,
      timeWindow: 60000,
      keyGenerator: () => 'public-dashboard',
      errorResponseBuilder: () => ({
        statusCode: 429,
        message: 'Trop de demandes. Réessayez dans une minute.',
      }),
    })
  let loading = false
  let cached: { scope: string; at: number; data: Dataset } | undefined
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    const origin = req.headers.origin
    if (
      !hosts.includes(req.headers.host ?? '') ||
      (origin && !origins.includes(origin)) ||
      (req.headers['sec-fetch-site'] &&
        !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
    )
      return reply.code(403).send({ message: 'Adresse ou origine non autorisée.' })
    // This listener is private to Docker. Caddy overwrites this header at the HTTPS boundary.
    if (publicOrigin && req.headers['x-forwarded-proto'] !== 'https')
      return reply.code(400).send({ message: 'Ouvrez le dashboard en HTTPS.' })
    if (req.method !== 'GET') return reply.code(405).send({ message: 'Consultation uniquement.' })
    // A cross-origin page cannot attach this header without a denied CORS preflight.
    if (req.url.startsWith('/api/') && req.headers['x-samhain-dashboard'] !== '1')
      return reply.code(403).send({ message: 'Ouvrez le tableau de bord dans votre navigateur.' })
  })
  app.setErrorHandler((error, _req, reply) => {
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) {
      void reply.code(429).send({ message: 'Trop de demandes. Réessayez dans une minute.' })
      return
    }
    const known = error instanceof Error ? error.message : ''
    const messages: Record<string, string> = {
      FILTER: 'Vérifiez les dates et les filtres saisis.',
      LIMIT:
        'Ce festival dépasse la limite de lecture (50 000 ventes ou événements, ou 64 Mo). Une agrégation dédiée est nécessaire ; aucun total partiel n’est affiché.',
      SCOPE: 'Ce festival est introuvable. Choisissez un festival de la liste.',
      BUSY: 'Une lecture est déjà en cours. Réessayez dans quelques secondes.',
    }
    void reply.code(known === 'FILTER' ? 400 : known === 'SCOPE' ? 404 : 503).send({
      message:
        messages[known] ??
        'Les données ne sont pas disponibles. Vérifiez la connexion MongoDB et les droits de lecture, puis actualisez.',
    })
  })
  app.get('/api/scopes', async () => {
    const scopes = await db
      .collection<Festival>('festivals')
      .find(
        {},
        { projection: { _id: 0, organizationId: 1, festivalId: 1, active: 1 }, maxTimeMS: 5000 },
      )
      .limit(501)
      .toArray()
    if (scopes.length > 500) throw new Error('LIMIT')
    return scopes
  })
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/report',
    async (req, reply) => {
      const q = req.query
      const filters = queryFilters(q)
      if (
        !uuid.test(q.organizationId ?? '') ||
        !uuid.test(q.festivalId ?? '') ||
        (q.page && !/^[1-9]\d{0,5}$/.test(q.page)) ||
        (q.format && q.format !== 'csv')
      )
        throw new Error('FILTER')
      const scope = { organizationId: q.organizationId!, festivalId: q.festivalId! }
      const cacheKey = `${scope.organizationId}/${scope.festivalId}`
      if (publicOrigin && cached?.scope === cacheKey && Date.now() - cached.at < 15000) {
        if (q.format === 'csv')
          return reply
            .header('Content-Disposition', 'attachment; filename="ventes-samhain.csv"')
            .type('text/csv; charset=utf-8')
            .send(salesCsv(cached.data, filters))
        return {
          ...report(cached.data, filters, Number(q.page ?? 1)),
          generatedAt: new Date(cached.at).toISOString(),
        }
      }
      if (loading) throw new Error('BUSY')
      loading = true
      try {
        if (!(await db.collection<Festival>('festivals').findOne(scope, { maxTimeMS: 5000 })))
          throw new Error('SCOPE')
        // Immutable documents, majority reads; no writes, schema changes or auth collections.
        // One request uses one loaded dataset for all its figures and its page of sales.
        const budget = { bytes: 0 }
        const events = await readRows(
          db
            .collection<LedgerEvent>('ledgerEvents')
            .find(
              { ...scope, kind: { $in: ['sale', 'correction'] } },
              { readConcern: { level: 'majority' }, maxTimeMS: 10000 },
            )
            .limit(limit + 1),
          budget,
        )
        const legacy = await readRows(
          db
            .collection<Extract<Sale, { type: 'legacy' }>>('sales')
            .find(
              { ...scope, type: 'legacy' },
              { readConcern: { level: 'majority' }, maxTimeMS: 10000 },
            )
            .limit(limit + 1),
          budget,
        )
        const data = dataset(events, legacy)
        if (publicOrigin) cached = { scope: cacheKey, at: Date.now(), data }
        if (q.format === 'csv')
          return reply
            .header('Content-Disposition', 'attachment; filename="ventes-samhain.csv"')
            .type('text/csv; charset=utf-8')
            .send(salesCsv(data, filters))
        return {
          ...report(data, filters, Number(q.page ?? 1)),
          ...(publicOrigin && cached ? { generatedAt: new Date(cached.at).toISOString() } : {}),
        }
      } finally {
        loading = false
      }
    },
  )
  app.get('/*', async (req, reply) => {
    const path = req.url.split('?')[0] ?? ''
    const asset = /^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.exec(path)
    if (path !== '/' && path !== '/index.html' && !asset)
      return reply.code(404).send({ message: 'Page introuvable.' })
    try {
      const content = await readFile(`${dist}/${asset ? path.slice(1) : 'index.html'}`)
      return reply
        .type(
          asset ? (asset[1] === 'js' ? 'text/javascript' : 'text/css') : 'text/html; charset=utf-8',
        )
        .send(content)
    } catch {
      return reply
        .code(503)
        .type('text/plain')
        .send('Interface absente. Lancez pnpm dashboard:build puis redémarrez.')
    }
  })
  return app
}
