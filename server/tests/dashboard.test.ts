import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from 'mongodb'
import { dataset, report, salesCsv, parisDay } from '../src/dashboard/report.ts'
import type { Filters } from '../src/dashboard/types.ts'
import { dashboardApp, queryFilters } from '../src/dashboard/server.ts'
import type { LedgerEvent, Sale } from '../src/persistence/model.ts'
import { correction, ledger, order } from './ledger-fixtures.ts'
import { dashboardConfig } from '../src/dashboard/config.ts'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  festivalId: '22222222-2222-4222-8222-222222222222',
  chainId: '33333333-3333-4333-8333-333333333333',
}
const filters: Filters = { from: '', to: '', terminal: '', payment: '', search: '' }
function event(kind = 'sale', value?: unknown): LedgerEvent {
  const proof = ledger(scope, kind, value)
  return {
    ...scope,
    ...proof,
    documentSchemaVersion: 1,
    kind: kind as LedgerEvent['kind'],
    ledgerSchemaVersion: 1,
    protocolVersion: 1,
    recordedAt: '2026-10-24T10:00:00Z',
    serverReceivedAt: new Date('2026-10-24T11:00:00Z'),
  }
}
const legacy: Sale = {
  ...scope,
  documentSchemaVersion: 1,
  type: 'legacy',
  orderId: 'old',
  sourceTerminalId: 'test-terminal',
  payloadCanonical: JSON.stringify(order('old')),
  transportFingerprint: 'test',
  protocolVersion: 1,
}

test('counts sealed sales once, includes legacy, keeps signed corrections and exact cents', () => {
  const sale = event()
  const c = event('correction', correction(sale))
  const reservation: Sale = {
    ...scope,
    documentSchemaVersion: 1,
    type: 'sealed',
    orderId: 'reservation',
    ledgerEventId: sale.eventId,
    saleHash: sale.hash,
  }
  const data = dataset([sale, c], [legacy, reservation])
  const result = report(data, filters, 1)
  assert.deepEqual(result.totals, {
    count: 2,
    gross: 404,
    corrections: -101,
    net: 303,
    average: 202,
    correctionCount: 1,
    legacyCount: 1,
  })
  assert.equal(result.payments[0]?.totals.net, 303)
  assert.equal(result.products[0]?.quantity, 4)
  assert.equal(result.tablets.length, 1)
  assert.equal(result.tablets[0]?.lastReceivedAt, '2026-10-24T11:00:00.000Z')
})
test('uses inclusive Paris days, including midnight and the DST switch', () => {
  assert.equal(parisDay('2026-10-24T22:30:00Z'), '2026-10-25')
  assert.equal(parisDay('2026-10-25T23:30:00Z'), '2026-10-26')
  const s = order()
  s.paidAt = '2026-10-24T22:30:00Z'
  const d = dataset([event('sale', s)], [])
  assert.equal(report(d, { ...filters, from: '2026-10-25', to: '2026-10-25' }, 1).totals.count, 1)
  assert.equal(report(d, { ...filters, to: '2026-10-24' }, 1).totals.count, 0)
})
test('filters tablet, payment and search; corrections keep their own period', () => {
  const card = order()
  card.paymentMethod = 'card'
  card.terminal = { ...card.terminal, terminalId: 'other' }
  const e = event('sale', card)
  e.sourceTerminalId = 'other'
  const original = event()
  const c = event('correction', correction(original))
  c.recordedAt = '2026-10-26T10:00:00Z'
  const d = dataset([original, e, c], [])
  assert.equal(report(d, { ...filters, terminal: 'other', payment: 'card' }, 1).totals.count, 1)
  assert.equal(report(d, { ...filters, terminal: 'other', payment: 'cash' }, 1).totals.count, 0)
  assert.equal(report(d, { ...filters, from: '2026-10-26', to: '2026-10-26' }, 1).totals.net, -101)
  assert.equal(report(d, { ...filters, search: 'no-such-order' }, 1).totals.net, 0)
})
test('paginates all matching sales and exports every page with formula protection', () => {
  const d = dataset(
    Array.from({ length: 51 }, (_, i) => {
      const s = order(String(i))
      s.orderNumber = '=HYPERLINK("x")'
      return event('sale', s)
    }),
    [],
  )
  assert.equal(report(d, filters, 1).sales.length, 50)
  assert.equal(report(d, filters, 2).sales.length, 1)
  assert.equal(report(d, filters, 999).page, 2)
  const csv = salesCsv(d, filters)
  assert.equal(csv.split('\r\n').length, 52)
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes("'=HYPERLINK"))
})
test('rejects invalid payloads and invalid filters instead of showing partial totals', () => {
  assert.throws(() => dataset([{ ...event(), payloadCanonical: '{}' }], []))
  for (const q of [
    { from: '2026-02-30' },
    { from: '2026-12-01', to: '2026-01-01' },
    { payment: 'other' },
    { search: 'a'.repeat(121) },
  ])
    assert.throws(() => queryFilters(q))
  assert.deepEqual(report({ sales: [], corrections: [] }, filters, 1).totals, {
    count: 0,
    gross: 0,
    corrections: 0,
    net: 0,
    average: 0,
    correctionCount: 0,
    legacyCount: 0,
  })
})

test('local API rejects foreign hosts/origins, missing header, writes and invalid scope', async () => {
  const reads: { collection: string; filter: unknown }[] = []
  let mode = 'normal'
  // Minimal read-only DB substitute; any unexpected database method fails the test.
  const db = {
    collection(name: string) {
      return {
        find(filter: unknown) {
          reads.push({ collection: name, filter })
          return {
            limit() {
              return this
            },
            async toArray() {
              if (mode === 'failure') throw new Error('mongodb://secret-fixture')
              if (mode === 'limit' && name === 'ledgerEvents') return Array(50_001).fill(event())
              return name === 'festivals' ? [{ ...scope, active: true }] : []
            },
            async *[Symbol.asyncIterator]() {
              yield* await this.toArray()
            },
            async close() {},
          }
        },
        async findOne(filter: unknown) {
          reads.push({ collection: name, filter })
          return { ...scope, active: true }
        },
      }
    },
  } as unknown as Db
  const app = await dashboardApp(db, 4310)
  const headers = { host: '127.0.0.1:4310', 'x-samhain-dashboard': '1' }
  try {
    assert.equal(
      (
        await app.inject({
          url: '/api/scopes',
          headers: { host: 'evil.example:4310', 'x-samhain-dashboard': '1' },
        })
      ).statusCode,
      403,
    )
    assert.equal(
      (
        await app.inject({
          url: '/api/scopes',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    )
    assert.equal(
      (await app.inject({ url: '/api/scopes', headers: { host: headers.host } })).statusCode,
      403,
    )
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/scopes', headers })).statusCode,
      405,
    )
    assert.equal(reads.length, 0)
    assert.equal(
      (await app.inject({ url: '/api/report?organizationId=bad', headers })).statusCode,
      400,
    )
    const url = `/api/report?organizationId=${scope.organizationId}&festivalId=${scope.festivalId}`
    const result = await app.inject({ url, headers })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().totals.count, 0)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.deepEqual(reads.find((r) => r.collection === 'ledgerEvents')?.filter, {
      organizationId: scope.organizationId,
      festivalId: scope.festivalId,
      kind: { $in: ['sale', 'correction'] },
    })
    assert.deepEqual(reads.find((r) => r.collection === 'sales')?.filter, {
      organizationId: scope.organizationId,
      festivalId: scope.festivalId,
      type: 'legacy',
    })
    assert.equal(
      (await app.inject({ url: `${url}&format=csv`, headers })).headers['content-type'],
      'text/csv; charset=utf-8',
    )
    mode = 'limit'
    const tooLarge = await app.inject({ url, headers })
    assert.equal(tooLarge.statusCode, 503)
    assert.match(tooLarge.json().message, /aucun total partiel/)
    assert.equal(tooLarge.json().totals, undefined)
    mode = 'failure'
    const unavailable = await app.inject({ url, headers })
    assert.equal(unavailable.statusCode, 503)
    assert.ok(!unavailable.body.includes('secret-fixture'))
  } finally {
    await app.close()
  }
})

test('public mode requires an explicit HTTPS origin and local remains the default', () => {
  assert.deepEqual(dashboardConfig({}), { port: 4310, host: '127.0.0.1' })
  for (const env of [
    { DASHBOARD_PUBLIC: 'yes' },
    { DASHBOARD_PUBLIC: 'true' },
    { DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com' },
    { DASHBOARD_PUBLIC: 'true', DASHBOARD_PUBLIC_ORIGIN: 'http://dashboard.example.com' },
    {
      DASHBOARD_PUBLIC: 'true',
      DASHBOARD_PUBLIC_ORIGIN: 'https://user:secret@dashboard.example.com',
    },
    { DASHBOARD_PUBLIC: 'true', DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com/path' },
  ])
    assert.throws(() => dashboardConfig(env))
  assert.deepEqual(
    dashboardConfig({
      DASHBOARD_PUBLIC: 'true',
      DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com',
    }),
    { port: 4310, host: '0.0.0.0', publicOrigin: 'https://dashboard.example.com' },
  )
})

test('public dashboard serves without authentication behind HTTPS, caches reads, rejects foreign origins and limits traffic', async () => {
  let reads = 0
  const db = {
    collection() {
      return {
        async findOne() {
          return scope
        },
        find() {
          reads++
          return {
            limit() {
              return this
            },
            async toArray() {
              return []
            },
            async *[Symbol.asyncIterator]() {},
            async close() {},
          }
        },
      }
    },
  } as unknown as Db
  const directory = await mkdtemp(join(tmpdir(), 'samhain-dashboard-test-'))
  await writeFile(join(directory, 'index.html'), '<html lang="fr">Dashboard public</html>')
  const app = await dashboardApp(db, 4310, directory, {
    publicOrigin: 'https://dashboard.samhain.arthurdubos.fr',
  })
  const headers = {
    host: 'dashboard.samhain.arthurdubos.fr',
    'x-forwarded-proto': 'https',
    'x-samhain-dashboard': '1',
  }
  try {
    const page = await app.inject({ url: '/', headers })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Dashboard public/)
    assert.match(String(page.headers['strict-transport-security']), /max-age/)
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
    assert.equal(
      (await app.inject({ url: '/', headers: { ...headers, 'x-forwarded-proto': 'http' } }))
        .statusCode,
      400,
    )
    assert.equal(
      (
        await app.inject({
          url: '/api/scopes',
          headers: { ...headers, origin: 'https://other.example.com' },
        })
      ).statusCode,
      403,
    )
    assert.equal(
      (await app.inject({ url: '/api/scopes', headers: { ...headers, host: 'other.example.com' } }))
        .statusCode,
      403,
    )
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/scopes', headers })).statusCode,
      405,
    )
    const url = `/api/report?organizationId=${scope.organizationId}&festivalId=${scope.festivalId}`
    const first = await app.inject({ url, headers })
    assert.equal(first.statusCode, 200)
    assert.equal(reads, 2)
    const second = await app.inject({ url: `${url}&page=2`, headers })
    assert.equal(second.statusCode, 200)
    assert.equal(reads, 2)
    assert.equal(second.json().generatedAt, first.json().generatedAt)
    let last = first
    for (let i = 0; i < 241; i++) last = await app.inject({ url: '/api/scopes', headers })
    assert.equal(last.statusCode, 429)
    assert.match(last.json().message, /Trop de demandes/)
  } finally {
    await app.close()
    await unlink(join(directory, 'index.html'))
    await rmdir(directory)
  }
})
