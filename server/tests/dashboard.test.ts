import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from 'mongodb'
import { dataset, report } from '../src/dashboard/report.ts'
import { includedVat } from '../src/dashboard/analytics.ts'
import { csvChunks } from '../src/dashboard/exports.ts'
import { dashboardApp, queryFilters } from '../src/dashboard/server.ts'
import { dashboardConfig } from '../src/dashboard/config.ts'
import { defaultPeriod, festivalDays, parisDay, shiftDay } from '../src/dashboard/periods.ts'
import type { Dataset, Filters, DashboardSettings, ExportKind } from '../src/dashboard/types.ts'
import type { LedgerEvent, Sale } from '../src/persistence/model.ts'
import { correction, ledger, order, source, terminal } from './ledger-fixtures.ts'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  festivalId: '22222222-2222-4222-8222-222222222222',
  chainId: '33333333-3333-4333-8333-333333333333',
}
const env = {
  DASHBOARD_ORGANIZATION_ID: scope.organizationId,
  DASHBOARD_FESTIVAL_ID: scope.festivalId,
  DASHBOARD_FESTIVAL_START_DATE: '2026-10-22',
}
const settings: DashboardSettings = {
  ...dashboardConfig(env).settings,
  defaultPeriod: { from: '2026-10-22', to: '2026-10-25' },
}
const filters: Filters = {
  ...settings.defaultPeriod,
  terminal: '',
  payment: '',
  search: '',
  corrected: 'any',
  productIds: '',
}
function event(
  kind = 'sale',
  value?: unknown,
  at = '2026-10-24T10:00:00Z',
  tablet = terminal.terminalId,
): LedgerEvent {
  const p = ledger(scope, kind, value, undefined, undefined, {
    recordedAt: at,
    source: { ...source, terminal: { ...terminal, terminalId: tablet } },
  })
  return {
    ...scope,
    ...p,
    documentSchemaVersion: 1,
    kind: kind as LedgerEvent['kind'],
    sourceTerminalId: tablet,
    ledgerSchemaVersion: 1,
    protocolVersion: 1,
    recordedAt: at,
    serverReceivedAt: new Date(at),
  }
}
function sale(
  id = 's1',
  at = '2026-10-24T10:00:00Z',
  tablet = terminal.terminalId,
  method = 'cash',
) {
  const o = order(id)
  o.paidAt = at
  o.terminal.terminalId = tablet
  o.paymentMethod = method
  return event('sale', o, at, tablet)
}
function detailedRefund(original: LedgerEvent, at = '2026-10-24T11:00:00Z') {
  const c = correction(original, {
    refundLines: [
      {
        originalLineId: 'line/1',
        productId: 'test/1',
        productName: 'Test',
        quantity: 1,
        unitPriceCents: 101,
        vatRate: 10,
        grossCents: 101,
        vatCents: 9,
      },
    ],
  })
  return event('correction', c, at, original.sourceTerminalId)
}
const build = (d: Dataset, f = filters, page = 1, correctionPage = 1) =>
  report(d, f, page, settings, correctionPage, '2026-10-25T14:00:00Z')

test('configuration enforces one UUID scope, a Thursday, refresh/goals and explicit public mode', () => {
  assert.deepEqual(dashboardConfig(env).scope, {
    organizationId: scope.organizationId,
    festivalId: scope.festivalId,
  })
  assert.equal(dashboardConfig(env).host, '127.0.0.1')
  for (const bad of [
    { DASHBOARD_ORGANIZATION_ID: '' },
    { DASHBOARD_FESTIVAL_ID: 'other' },
    { DASHBOARD_FESTIVAL_START_DATE: '2026-10-23' },
    { DASHBOARD_FESTIVAL_START_DATE: '2026-02-30' },
    { DASHBOARD_REFRESH_SECONDS: '0' },
    { DASHBOARD_DAILY_GOAL_CENTS: '-1' },
    { DASHBOARD_DAILY_GOAL_CENTS: '12.5' },
    { DASHBOARD_PUBLIC: 'true' },
    { DASHBOARD_PUBLIC: 'yes' },
    { DASHBOARD_PUBLIC: 'true', DASHBOARD_PUBLIC_ORIGIN: 'http://example.com' },
    { DASHBOARD_PUBLIC: 'true', DASHBOARD_PUBLIC_ORIGIN: 'https://user:secret@example.com' },
  ])
    assert.throws(() => dashboardConfig({ ...env, ...bad }))
  const c = dashboardConfig({
    ...env,
    DASHBOARD_PUBLIC: 'true',
    DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com',
    DASHBOARD_DAILY_GOAL_CENTS: '10000',
    DASHBOARD_REFRESH_SECONDS: '90',
  })
  assert.equal(c.host, '0.0.0.0')
  assert.equal(c.settings.goals.daily, 10000)
  assert.equal(c.settings.refreshSeconds, 90)
})
test('Thursday through Sunday, today/yesterday defaults and Paris DST boundaries use civil dates', () => {
  assert.deepEqual(
    festivalDays('2026-10-22').map((d) => d.date),
    ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'],
  )
  assert.deepEqual(defaultPeriod('2026-10-22', new Date('2026-10-24T22:30:00Z')), {
    from: '2026-10-25',
    to: '2026-10-25',
  })
  assert.deepEqual(
    defaultPeriod('2026-10-22', new Date('2026-10-26T00:00:00Z')),
    settings.defaultPeriod,
  )
  assert.equal(shiftDay('2026-03-29', -1), '2026-03-28')
  assert.equal(shiftDay('2026-10-25', 1), '2026-10-26')
  assert.equal(parisDay('2026-10-24T22:30:00Z'), '2026-10-25')
  const d = dataset(
    [
      sale('w1', '2026-10-25T00:30:00Z'),
      sale('w2', '2026-10-25T01:30:00Z'),
      sale('outside', '2026-10-25T23:30:00Z'),
    ],
    [],
  )
  const r = build(d, { ...filters, from: '2026-10-25', to: '2026-10-25' })
  assert.equal(r.totals.count, 2)
  assert.equal(r.hours[2]?.totals.count, 2)
  assert.equal(r.hours.length, 24)
  const summer = build(
    dataset([sale('su1', '2026-03-29T00:30:00Z'), sale('su2', '2026-03-29T01:30:00Z')], []),
    { ...filters, from: '2026-03-29', to: '2026-03-29' },
  )
  assert.equal(summer.hours[1]?.totals.count, 1)
  assert.equal(summer.hours[2]?.totals.count, 0)
  assert.equal(summer.hours[3]?.totals.count, 1)
  for (const date of settings.days.map((d) => d.date))
    assert.equal(
      build(dataset([sale('each', `${date}T10:00:00Z`)], []), { ...filters, from: date, to: date })
        .totals.count,
      1,
    )
})
test('sealed reservations do not double count legacy and signed corrections; zero is only a successful empty read', () => {
  const s = sale(),
    legacy: Sale = {
      ...scope,
      documentSchemaVersion: 1,
      type: 'legacy',
      orderId: 'old',
      sourceTerminalId: terminal.terminalId,
      payloadCanonical: JSON.stringify({ ...order('old'), paidAt: '2026-10-24T10:00:00Z' }),
      transportFingerprint: 'test',
      protocolVersion: 1,
    }
  const reservation: Sale = {
    ...scope,
    documentSchemaVersion: 1,
    type: 'sealed',
    orderId: 's1',
    ledgerEventId: s.eventId,
    saleHash: s.hash,
  }
  const r = build(dataset([s, detailedRefund(s)], [legacy, reservation]))
  assert.equal(r.totals.count, 2)
  assert.equal(r.totals.gross, 404)
  assert.equal(r.totals.net, 303)
  assert.equal(r.totals.corrections, -101)
  assert.equal(r.totals.average, 202)
  assert.equal(r.totals.articles, 4)
  assert.equal(r.totals.articlesAverage, 2)
  assert.equal(r.totals.legacyCount, 1)
  assert.equal(build({ sales: [], corrections: [] }).totals.net, 0)
  assert.throws(() => dataset([{ ...s, payloadCanonical: '{}' }], []))
})
test('historical product IDs are distinct even for matching names, and renames retain historical aliases', () => {
  const a = order('a'),
    b = order('b'),
    renamed = order('c')
  b.items[0]!.productId = 'different,id'
  renamed.items[0]!.name = 'Nom ultérieur'
  renamed.paidAt = '2026-10-24T12:00:00Z'
  const d = dataset([event('sale', a), event('sale', b), event('sale', renamed)], [])
  const r = build(d)
  assert.equal(r.products.length, 2)
  assert.equal(r.products.find((p) => p.id === 'test/1')?.quantity, 4)
  assert.deepEqual(r.products.find((p) => p.id === 'test/1')?.names, ['Test', 'Nom ultérieur'])
  assert.equal(
    build(d, { ...filters, productIds: JSON.stringify(['different,id']) }).totals.count,
    1,
  )
  assert.equal(r.categories.available, false)
})
test('structured refunds and cancellations allocate exactly; historical amount-only adjustments stay unavailable', () => {
  const s = sale(),
    known = build(dataset([s, detailedRefund(s)], []))
  assert.equal(known.products[0]?.netQuantity, 1)
  assert.equal(known.products[0]?.netCents, 101)
  assert.equal(known.tax.total.gross, 202)
  assert.equal(known.tax.total.vat, 18)
  assert.equal(known.tax.total.netVat, 9)
  assert.equal(known.tax.total.netExcludingVat, 92)
  const cancelled = build(
    dataset(
      [s, event('correction', correction(s, { type: 'cancellation', amountDeltaCents: -202 }))],
      [],
    ),
  )
  assert.equal(cancelled.products[0]?.netQuantity, 0)
  assert.equal(cancelled.tax.total.net, 0)
  const unknown = build(dataset([s, event('correction', correction(s))], []))
  assert.equal(unknown.totals.net, 101)
  assert.equal(unknown.products[0]?.netQuantity, null)
  assert.equal(unknown.products[0]?.netCents, null)
  assert.equal(unknown.tax.complete, false)
  assert.equal(unknown.tax.total.netVat, null)
  const mismatch = build(
    dataset(
      [
        s,
        event(
          'correction',
          correction(s, {
            amountDeltaCents: -50,
            refundLines: JSON.parse(detailedRefund(s).payloadCanonical).correction.refundLines,
          }),
        ),
      ],
      [],
    ),
  )
  assert.equal(mismatch.tax.complete, false)
  assert.equal(includedVat(303, 10), 28)
  assert.equal(includedVat(9_000_000_000_000_000, 20), 1_500_000_000_000_000)
})
test('corrections retain their own dates, original sale links, payment and independent pagination', () => {
  const originals = Array.from({ length: 51 }, (_, i) => sale(`old-${i}`, '2026-10-22T10:00:00Z'))
  const corrections = originals.map((s) => detailedRefund(s, '2026-10-24T10:00:00Z'))
  const d = dataset([...originals, ...corrections], [])
  const r = build(d, { ...filters, from: '2026-10-24', to: '2026-10-24' }, 1, 2)
  assert.equal(r.totals.count, 0)
  assert.equal(r.totals.net, -5151)
  assert.equal(r.products[0]?.netQuantity, -51)
  assert.equal(r.corrections.length, 1)
  assert.equal(r.correctionPageCount, 2)
  const originalPeriod = build(d, {
    ...filters,
    from: '2026-10-22',
    to: '2026-10-22',
    corrected: 'with',
  })
  assert.equal(originalPeriod.sales[0]?.corrections.length, 1)
  assert.equal(originalPeriod.totals.corrections, 0)
  assert.equal(build(d, { ...filters, corrected: 'without' }).saleCount, 0)
})
test('options/variants/removed ingredients count historical selections without counting prices twice', () => {
  const o = order('custom')
  Object.assign(o.items[0]!, {
    variant: { id: 'v1', name: 'Variante test' },
    options: [
      {
        groupId: 'g',
        groupName: 'Choix',
        optionId: 'opt1',
        optionName: 'Supplément test',
        priceDeltaCents: 20,
      },
    ],
    ingredients: [{ id: 'i1', name: 'Ingrédient test' }],
    removedIngredientIds: ['i1'],
  })
  const r = build(dataset([event('sale', o)], []))
  assert.equal(r.totals.gross, 202)
  assert.equal(r.choices.length, 3)
  assert.ok(r.choices.every((c) => c.quantity === 2))
  assert.ok(r.choices.some((c) => c.supplement))
})
test('tablet/payment/time comparisons, synchronization evidence and unfiltered goals are honest', () => {
  const d = dataset(
    [sale('a', '2026-10-23T10:00:00Z'), sale('b', '2026-10-24T10:00:00Z', 'other-tablet', 'card')],
    [],
  )
  d.sync = [
    {
      chainId: scope.chainId,
      lastReceivedAt: '2026-10-25T12:00:00Z',
      head: 2,
      receivedSequence: 2,
    },
  ]
  const r = report(
    d,
    { ...filters, from: '2026-10-24', to: '2026-10-24', terminal: 'other-tablet' },
    1,
    { ...settings, goals: { daily: 1000, festival: 2000 } },
  )
  assert.equal(r.payments.find((p) => p.name === 'card')?.share, 100)
  assert.equal(r.payments.find((p) => p.name === 'cash')?.totals.count, 0)
  assert.equal(r.comparison.available, false)
  assert.equal(r.comparison.differences[0]?.percent, null)
  assert.equal(r.festival.length, 4)
  assert.equal(r.goals[1]?.actual, 404)
  assert.equal(r.goals[1]?.remaining, 1596)
  assert.equal(r.tablets[0]?.pending, null)
  assert.equal(Date.parse(r.tablets[0]?.lastSyncAt ?? ''), Date.parse('2026-10-25T12:00:00Z'))
  assert.ok(r.tablets.every((t) => !t.warning?.includes('hors ligne')))
  const compared = build(d, {
    ...filters,
    from: '2026-10-24',
    to: '2026-10-24',
    compareFrom: '2026-10-23',
    compareTo: '2026-10-23',
  })
  assert.equal(compared.comparison.available, true)
  assert.equal(compared.comparison.differences[0]?.percent, 0)
})
test('server filters reject scope injection, arrays, wrong dates, unsupported payment and ambiguous product lists', () => {
  for (const q of [
    { organizationId: scope.organizationId },
    { festivalId: scope.festivalId },
    { from: '2026-02-30' },
    { from: '2026-10-25', to: '2026-10-22' },
    { from: '2020-01-01', to: '2026-10-22' },
    { compareFrom: '2026-10-22' },
    { payment: 'crypto' },
    { productIds: 'a,b' },
    { productIds: '[1]' },
    { page: '0' },
    { search: 'x'.repeat(121) },
  ])
    assert.throws(() => queryFilters(q, settings))
  assert.equal(
    queryFilters({ productIds: '["id,with,comma"]' }, settings).productIds,
    '["id,with,comma"]',
  )
})
test('every CSV export covers all rows, has BOM/Excel separators and neutralizes formula cells', () => {
  const events = Array.from({ length: 51 }, (_, i) => {
    const o = order(String(i))
    o.orderNumber = '=FORMULE("test")'
    return event('sale', o)
  })
  const d = dataset(events, []),
    csv = (kind: ExportKind) => [...csvChunks(d, filters, settings, kind)].join('')
  assert.equal(build(d).sales.length, 50)
  assert.equal(csv('orders').split('\r\n').length, 53)
  assert.ok(csv('orders').includes("'=FORMULE"))
  assert.equal(csv('lines').split('\r\n').length, 53)
  for (const kind of [
    'orders',
    'lines',
    'products',
    'categories',
    'tablets',
    'corrections',
    'days',
    'vat',
  ] as const) {
    assert.ok(csv(kind).startsWith('\uFEFF'))
    assert.ok(csv(kind).includes(';'))
  }
  assert.match(csv('categories'), /Indisponible/)
  assert.match(csv('orders'), /Europe\/Paris/)
  assert.equal(
    [...csvChunks({ sales: [], corrections: [] }, filters, settings, 'orders')].length,
    2,
  )
  const original = sale(),
    corrected = dataset([original, detailedRefund(original)], [])
  const negative = [...csvChunks(corrected, filters, settings, 'corrections')].join('')
  assert.ok(negative.includes('"-1,01"'))
  assert.ok(!negative.includes('"\'-1,01"'))
})

function fakeDb(events: LedgerEvent[] = [], legacy: Sale[] = []) {
  const calls: { name: string; filter: Record<string, unknown>; operation: string }[] = []
  let failure = false,
    countOverride: number | null = null
  const db = {
    collection(name: string) {
      return {
        aggregate(pipeline: Record<string, unknown>[]) {
          calls.push({
            name,
            operation: 'aggregate',
            filter: pipeline[0]!.$match as Record<string, unknown>,
          })
          return {
            async toArray() {
              if (failure) throw new Error('mongodb://private-password')
              return name === 'ledgerEvents'
                ? [{ _id: 'sale', count: countOverride ?? events.length }]
                : []
            },
          }
        },
        find(filter: Record<string, unknown>) {
          calls.push({ name, filter, operation: 'find' })
          const values = name === 'ledgerEvents' ? events : name === 'sales' ? legacy : []
          return {
            limit() {
              return this
            },
            async toArray() {
              return values
            },
            async *[Symbol.asyncIterator]() {
              yield* values
            },
            async close() {},
          }
        },
      }
    },
  } as unknown as Db
  return {
    db,
    calls,
    fail() {
      failure = true
    },
    oversized() {
      countOverride = 50001
    },
  }
}
test('API imposes the configured scope, shares reads, streams exports and never exposes auth collections', async () => {
  const fake = fakeDb([sale()]),
    app = await dashboardApp(fake.db, 4310, undefined, { scope, settings })
  const headers = { host: '127.0.0.1:4310', 'x-samhain-dashboard': '1' }
  try {
    const config = await app.inject({ url: '/api/config', headers })
    assert.equal(config.statusCode, 200)
    assert.ok(!config.body.includes(scope.organizationId))
    assert.ok(!config.body.includes(scope.festivalId))
    assert.equal((await app.inject({ url: '/api/scopes', headers })).statusCode, 404)
    assert.equal(
      (await app.inject({ url: `/api/report?organizationId=${scope.organizationId}`, headers }))
        .statusCode,
      400,
    )
    assert.equal(fake.calls.length, 0)
    const [a, b] = await Promise.all([
      app.inject({ url: '/api/report?from=2026-10-22&to=2026-10-25', headers }),
      app.inject({ url: '/api/report?from=2026-10-22&to=2026-10-25&page=2', headers }),
    ])
    assert.equal(a.statusCode, 200)
    assert.ok(!a.body.includes(scope.chainId))
    assert.equal(b.statusCode, 200)
    assert.equal(a.json().totals.count, 1)
    assert.equal(a.json().generatedAt, b.json().generatedAt)
    assert.equal(
      fake.calls.filter((c) => c.name === 'ledgerEvents' && c.operation === 'find').length,
      1,
    )
    assert.ok(
      fake.calls.every(
        (c) =>
          c.filter.organizationId === scope.organizationId &&
          c.filter.festivalId === scope.festivalId,
      ),
    )
    assert.ok(
      fake.calls.every((c) => ['ledgerEvents', 'sales', 'syncReceipts', 'chains'].includes(c.name)),
    )
    assert.ok(fake.calls.every((c) => !('chainId' in c.filter)))
    for (const kind of [
      'orders',
      'lines',
      'products',
      'categories',
      'tablets',
      'corrections',
      'days',
      'vat',
    ]) {
      const r = await app.inject({
        url: `/api/report?from=2026-10-22&to=2026-10-25&format=csv&export=${kind}`,
        headers,
      })
      assert.equal(r.statusCode, 200)
      assert.match(String(r.headers['content-type']), /text\/csv/)
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/report', headers })).statusCode,
      405,
    )
  } finally {
    await app.close()
  }
})
test('MongoDB failures and limits return explicit errors without credentials or partial/zero totals', async () => {
  for (const mode of ['failure', 'limit']) {
    const fake = fakeDb()
    if (mode === 'failure') fake.fail()
    else fake.oversized()
    const app = await dashboardApp(fake.db, 4310, undefined, { scope, settings })
    try {
      const r = await app.inject({
        url: '/api/report',
        headers: { host: '127.0.0.1:4310', 'x-samhain-dashboard': '1' },
      })
      assert.equal(r.statusCode, 503)
      assert.equal(r.json().totals, undefined)
      assert.ok(!r.body.includes('private-password'))
      if (mode === 'limit') assert.match(r.json().message, /aucun total partiel/)
    } finally {
      await app.close()
    }
  }
})
test('public mode preserves HTTPS/origin/header checks, no authentication and HTTP quotas', async () => {
  const fake = fakeDb(),
    directory = await mkdtemp(join(tmpdir(), 'samhain-dashboard-test-'))
  await writeFile(join(directory, 'index.html'), '<html lang="fr">Dashboard public</html>')
  const app = await dashboardApp(fake.db, 4310, directory, {
    scope,
    settings,
    publicOrigin: 'https://dashboard.samhain.arthurdubos.fr',
  })
  const headers = {
    host: 'dashboard.samhain.arthurdubos.fr',
    'x-forwarded-proto': 'https',
    'x-samhain-dashboard': '1',
  }
  try {
    const r = await app.inject({ url: '/', headers })
    assert.equal(r.statusCode, 200)
    assert.match(String(r.headers['strict-transport-security']), /max-age/)
    assert.equal(
      (
        await app.inject({
          url: '/api/config',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    )
    assert.equal(
      (await app.inject({ url: '/api/config', headers: { ...headers, host: 'evil.example' } }))
        .statusCode,
      403,
    )
    assert.equal(
      (
        await app.inject({
          url: '/api/config',
          headers: { ...headers, 'x-forwarded-proto': 'http' },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await app.inject({
          url: '/api/config',
          headers: { host: headers.host, 'x-forwarded-proto': 'https' },
        })
      ).statusCode,
      403,
    )
    let last = r
    for (let i = 0; i < 241; i++) last = await app.inject({ url: '/api/config', headers })
    assert.equal(last.statusCode, 429)
  } finally {
    await app.close()
    await unlink(join(directory, 'index.html'))
    await rmdir(directory)
  }
})

test('an expired cache retries MongoDB and reports failure rather than returning obsolete success', async (t) => {
  let now = Date.parse('2026-10-25T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  const fake = fakeDb([sale()]),
    app = await dashboardApp(fake.db, 4310, undefined, { scope, settings })
  const headers = { host: '127.0.0.1:4310', 'x-samhain-dashboard': '1' }
  try {
    const first = await app.inject({ url: '/api/report?from=2026-10-22&to=2026-10-25', headers })
    assert.equal(first.statusCode, 200)
    fake.fail()
    const cached = await app.inject({ url: '/api/report?from=2026-10-22&to=2026-10-25', headers })
    assert.equal(cached.statusCode, 200)
    assert.equal(cached.json().generatedAt, first.json().generatedAt)
    now += 15001
    const failure = await app.inject({ url: '/api/report?from=2026-10-22&to=2026-10-25', headers })
    assert.equal(failure.statusCode, 503)
    assert.equal(failure.json().totals, undefined)
  } finally {
    await app.close()
  }
})
test('an arithmetic overflow is rejected before starting a CSV response', async () => {
  const o = order('large')
  o.items[0]!.quantity = 1
  o.items[0]!.unitPriceCents = Number.MAX_SAFE_INTEGER
  o.itemCount = 1
  o.totalCents = Number.MAX_SAFE_INTEGER
  const fake = fakeDb([event('sale', o), event('sale', { ...o, id: 'large-2' })]),
    app = await dashboardApp(fake.db, 4310, undefined, { scope, settings })
  try {
    const r = await app.inject({
      url: '/api/report?from=2026-10-22&to=2026-10-25&format=csv',
      headers: { host: '127.0.0.1:4310', 'x-samhain-dashboard': '1' },
    })
    assert.equal(r.statusCode, 503)
    assert.match(String(r.headers['content-type']), /application\/json/)
    assert.ok(!r.body.startsWith('\uFEFF'))
  } finally {
    await app.close()
  }
})
test('five thousand synthetic sales retain exact totals and 24 complete hourly buckets', (t) => {
  const events = Array.from({ length: 5000 }, (_, i) =>
    sale(`volume-${i}`, `2026-10-${22 + (i % 4)}T12:00:00Z`),
  )
  const start = performance.now(),
    data = dataset(events, []),
    r = build(data)
  assert.equal(r.totals.count, 5000)
  assert.equal(r.totals.gross, 1_010_000)
  assert.equal(
    r.hours.reduce((sum, h) => sum + h.totals.count, 0),
    5000,
  )
  assert.equal(r.festival.at(-1)?.cumulativeCount, 5000)
  t.diagnostic(
    `Normalisation + rapport de 5 000 ventes fictives : ${Math.round(performance.now() - start)} ms (local, sans MongoDB).`,
  )
})
