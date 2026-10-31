import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Db } from 'mongodb'
import type { Scope } from '../persistence/model.ts'
import { report } from './report.ts'
import type { Filters, DashboardSettings, ExportKind } from './types.ts'
import { defaultPeriod, daysBetween, validDay } from './periods.ts'
import { dashboardStore } from './store.ts'
import { csvChunks, prepareExport } from './exports.ts'
import { Readable } from 'node:stream'

export function queryFilters(
  q: Record<string, string | undefined>,
  settings: DashboardSettings,
): Filters {
  const allowed = [
    'from',
    'to',
    'terminal',
    'payment',
    'search',
    'page',
    'correctionPage',
    'format',
    'export',
    'productIds',
    'productQuery',
    'corrected',
    'compareFrom',
    'compareTo',
  ]
  if (
    Object.keys(q).some((k) => !allowed.includes(k)) ||
    Object.values(q).some((v) => v !== undefined && typeof v !== 'string')
  )
    throw new Error('FILTER')
  const defaults = defaultPeriod(settings.days[0]!.date)
  if (q.productIds) {
    let ids: unknown
    try {
      ids = JSON.parse(q.productIds)
    } catch {
      throw new Error('FILTER')
    }
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((v) => typeof v !== 'string' || !v.trim() || v.length > 512)
    )
      throw new Error('FILTER')
  }
  const from = q.from || defaults.from,
    to = q.to || defaults.to
  for (const value of [from, to, q.compareFrom, q.compareTo])
    if (value && !validDay(value)) throw new Error('FILTER')
  if (
    from > to ||
    daysBetween(from, to) > 366 ||
    Boolean(q.compareFrom) !== Boolean(q.compareTo) ||
    (q.compareFrom &&
      q.compareTo &&
      (q.compareFrom > q.compareTo || daysBetween(q.compareFrom, q.compareTo) > 366)) ||
    (q.payment && !['cash', 'card'].includes(q.payment)) ||
    (q.corrected && !['any', 'with', 'without'].includes(q.corrected)) ||
    (q.search?.length ?? 0) > 120 ||
    (q.terminal?.length ?? 0) > 512 ||
    (q.productIds?.length ?? 0) > 4096 ||
    [q.page, q.correctionPage].some((v) => v && !/^[1-9]\d{0,5}$/.test(v))
  )
    throw new Error('FILTER')
  if ((q.productQuery?.length ?? 0) > 120) throw new Error('FILTER')
  return {
    from,
    to,
    terminal: q.terminal ?? '',
    payment: q.payment ?? '',
    search: q.search ?? '',
    productIds: q.productIds ?? '',
    productQuery: q.productQuery ?? '',
    corrected: q.corrected ?? 'any',
    compareFrom: q.compareFrom ?? '',
    compareTo: q.compareTo ?? '',
  }
}

export async function dashboardApp(
  db: Db,
  port: number,
  dist = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url)),
  options: { publicOrigin?: string; scope: Scope; settings: DashboardSettings },
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
  const readSnapshot = dashboardStore(db, options.scope)
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
      SCOPE: 'Le festival configuré est introuvable. Vérifiez la configuration du service.',
      BUSY: 'Une lecture est déjà en cours. Réessayez dans quelques secondes.',
    }
    void reply.code(known === 'FILTER' ? 400 : known === 'SCOPE' ? 404 : 503).send({
      message:
        messages[known] ??
        'Les données ne sont pas disponibles. Vérifiez la connexion MongoDB et les droits de lecture, puis actualisez.',
    })
  })
  app.get('/api/config', async () => ({
    ...options.settings,
    defaultPeriod: defaultPeriod(options.settings.days[0]!.date),
  }))
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/report',
    async (req, reply) => {
      const q = req.query,
        filters = queryFilters(q, options.settings)
      const kinds: ExportKind[] = [
        'orders',
        'lines',
        'products',
        'categories',
        'tablets',
        'corrections',
        'days',
        'vat',
      ]
      if ((q.format && q.format !== 'csv') || (q.export && !kinds.includes(q.export as ExportKind)))
        throw new Error('FILTER')
      const snapshot = await readSnapshot()
      if (q.format === 'csv') {
        const kind = (q.export ?? 'orders') as ExportKind
        const prepared = prepareExport(snapshot.data, filters, options.settings)
        return reply
          .header('Content-Disposition', `attachment; filename="samhain-${kind}.csv"`)
          .type('text/csv; charset=utf-8')
          .send(Readable.from(csvChunks(snapshot.data, filters, options.settings, kind, prepared)))
      }
      return report(
        snapshot.data,
        filters,
        Number(q.page ?? 1),
        options.settings,
        Number(q.correctionPage ?? 1),
        snapshot.generatedAt,
      )
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
