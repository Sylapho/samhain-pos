import { add, multiply } from '../ledger/validation.ts'
import { filtered } from './report.ts'
import { daysBetween, shiftDay } from './periods.ts'
import type {
  Dataset,
  Filters,
  Totals,
  Report,
  ProductRow,
  TaxRow,
  ChoiceRow,
  DashboardSettings,
  RefundLine,
  SaleRow,
  CorrectionRow,
} from './types.ts'

export const orderKey = (chain: string, id: string) => JSON.stringify([chain, id])
function publicCorrection(c: CorrectionRow): Report['corrections'][number] {
  return {
    id: c.id,
    originalId: c.originalId,
    order: c.order,
    receipt: c.receipt,
    terminalId: c.terminalId,
    tablet: c.tablet,
    at: c.at,
    day: c.day,
    hour: c.hour,
    cents: c.cents,
    method: c.method,
    type: c.type,
    reason: c.reason,
    refundLines: c.refundLines,
  }
}
function publicSale(s: SaleRow): Omit<SaleRow, 'chainId'> {
  return {
    id: s.id,
    number: s.number,
    receipt: s.receipt,
    terminalId: s.terminalId,
    tablet: s.tablet,
    at: s.at,
    day: s.day,
    hour: s.hour,
    receivedAt: s.receivedAt,
    method: s.method,
    cents: s.cents,
    legacy: s.legacy,
    lines: s.lines,
  }
}
const empty = (): Totals => ({
  count: 0,
  gross: 0,
  corrections: 0,
  net: 0,
  articles: 0,
  average: 0,
  articlesAverage: 0,
})
function finish(t: Totals): Totals {
  return {
    ...t,
    net: add(t.gross, t.corrections),
    average: t.count ? Math.round(t.gross / t.count) : 0,
    articlesAverage: t.count ? t.articles / t.count : 0,
  }
}
export function totals(data: Dataset): Totals {
  const t = empty()
  for (const s of data.sales) {
    t.count++
    t.gross = add(t.gross, s.cents)
    for (const l of s.lines) t.articles = add(t.articles, l.quantity)
  }
  for (const c of data.corrections) t.corrections = add(t.corrections, c.cents)
  return finish(t)
}
function buckets(data: Dataset, dimension: 'day' | 'hour') {
  const values = new Map<string | number, Totals>()
  for (const s of data.sales) {
    const key = s[dimension],
      t = values.get(key) ?? empty()
    t.count++
    t.gross = add(t.gross, s.cents)
    for (const l of s.lines) t.articles = add(t.articles, l.quantity)
    values.set(key, t)
  }
  for (const c of data.corrections) {
    const key = c[dimension],
      t = values.get(key) ?? empty()
    t.corrections = add(t.corrections, c.cents)
    values.set(key, t)
  }
  return new Map([...values].map(([key, value]) => [key, finish(value)]))
}
export function hourly(data: Dataset) {
  const grouped = buckets(data, 'hour')
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, totals: grouped.get(h) ?? empty() }))
}
// Same per-line rounding as src/utils/vat.ts, using integer arithmetic to avoid overflow.
export function includedVat(gross: number, rate: number): number {
  const denominator = BigInt(100 + rate),
    numerator = BigInt(gross) * BigInt(rate)
  return Number((numerator + denominator / 2n) / denominator)
}
export function allocated(c: CorrectionRow, original: SaleRow | undefined): RefundLine[] | null {
  if (!original) return null
  if (c.type === 'cancellation' && c.cents === -original.cents)
    return original.lines.map((l) => ({
      originalLineId: l.lineId,
      productId: l.productId,
      productName: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      vatRate: l.vatRate,
      grossCents: multiply(l.quantity, l.unitPriceCents),
      vatCents: includedVat(multiply(l.quantity, l.unitPriceCents), l.vatRate),
    }))
  if (
    c.type !== 'refund' ||
    !c.refundLines?.length ||
    c.refundLines.reduce((sum, l) => add(sum, l.grossCents), 0) !== -c.cents
  )
    return null
  if (
    c.refundLines.some(
      (r) =>
        !original.lines.some(
          (l) =>
            l.lineId === r.originalLineId &&
            l.productId === r.productId &&
            l.unitPriceCents === r.unitPriceCents &&
            l.vatRate === r.vatRate,
        ) ||
        r.grossCents !== multiply(r.quantity, r.unitPriceCents) ||
        r.vatCents !== includedVat(r.grossCents, r.vatRate),
    )
  )
    return null
  return c.refundLines
}
export function buildReport(
  data: Dataset,
  f: Filters,
  page: number,
  settings: DashboardSettings,
  correctionPage = 1,
  generatedAt = new Date().toISOString(),
): Report {
  const selected = filtered(data, f),
    t = totals(selected)
  const originals = new Map(data.sales.map((s) => [orderKey(s.chainId, s.id), s]))
  const associated = new Map<string, CorrectionRow[]>()
  for (const c of data.corrections) {
    const k = orderKey(c.chainId, c.originalId)
    const entries = associated.get(k) ?? []
    entries.push(c)
    associated.set(k, entries)
  }
  const products = new Map<string, ProductRow>(),
    choices = new Map<string, ChoiceRow>(),
    taxes = new Map<number, TaxRow>()
  const product = (id: string, name: string) => {
    let p = products.get(id)
    if (!p) {
      p = {
        id,
        name,
        names: [name],
        quantity: 0,
        netQuantity: 0,
        cents: 0,
        netCents: 0,
        orderCount: 0,
        quantityShare: 0,
        revenueShare: 0,
      }
      products.set(id, p)
    }
    if (!p.names.includes(name)) p.names.push(name)
    return p
  }
  const tax = (rate: number) => {
    let r = taxes.get(rate)
    if (!r) {
      r = {
        rate,
        gross: 0,
        excludingVat: 0,
        vat: 0,
        corrections: 0,
        correctionVat: 0,
        net: 0,
        netExcludingVat: 0,
        netVat: 0,
      }
      taxes.set(rate, r)
    }
    return r
  }
  for (const s of [...selected.sales].sort((a, b) => a.at.localeCompare(b.at))) {
    const seen = new Set<string>()
    for (const l of s.lines) {
      const p = product(l.productId, l.name),
        cents = multiply(l.quantity, l.unitPriceCents),
        r = tax(l.vatRate)
      p.name = l.name
      p.quantity = add(p.quantity, l.quantity)
      p.netQuantity = add(p.netQuantity!, l.quantity)
      p.cents = add(p.cents, cents)
      p.netCents = add(p.netCents!, cents)
      if (!seen.has(p.id)) {
        p.orderCount++
        seen.add(p.id)
      }
      r.gross = add(r.gross, cents)
      r.vat = add(r.vat, includedVat(cents, l.vatRate))
      r.excludingVat = r.gross - r.vat
      const addChoice = (id: string, name: string, kind: ChoiceRow['kind'], supplement = false) => {
        const key = JSON.stringify([l.productId, kind, id]),
          existing = choices.get(key)
        choices.set(key, {
          id,
          name,
          kind,
          supplement,
          productId: l.productId,
          productName: l.name,
          quantity: add(existing?.quantity ?? 0, l.quantity),
        })
      }
      if (l.variant) addChoice(l.variant.id, l.variant.name, 'variant')
      for (const o of l.options)
        addChoice(JSON.stringify([o.groupId, o.id]), o.name, 'option', o.supplement)
      for (const i of l.removed) addChoice(i.id, i.name, 'removed')
    }
  }
  const incomplete = new Set<string>()
  let unallocated = 0,
    missingOriginal = false
  for (const c of selected.corrections) {
    const original = originals.get(orderKey(c.chainId, c.originalId)),
      lines = allocated(c, original)
    if (!lines) {
      unallocated++
      if (!original) missingOriginal = true
      for (const l of original?.lines ?? []) {
        product(l.productId, l.name)
        incomplete.add(l.productId)
      }
      continue
    }
    for (const l of lines) {
      const p = product(l.productId, l.productName),
        r = tax(l.vatRate)
      p.netQuantity = add(p.netQuantity!, -l.quantity)
      p.netCents = add(p.netCents!, -l.grossCents)
      r.corrections = add(r.corrections!, -l.grossCents)
      r.correctionVat = add(r.correctionVat!, -l.vatCents)
    }
  }
  for (const p of products.values()) {
    p.quantityShare = t.articles ? (100 * p.quantity) / t.articles : 0
    p.revenueShare = t.gross ? (100 * p.cents) / t.gross : 0
    if (missingOriginal || incomplete.has(p.id)) {
      p.netQuantity = null
      p.netCents = null
    }
  }
  for (const r of taxes.values()) {
    r.net = add(r.gross, r.corrections!)
    r.netVat = add(r.vat, r.correctionVat!)
    r.netExcludingVat = r.net - r.netVat
    if (unallocated) {
      r.corrections = null
      r.correctionVat = null
      r.net = null
      r.netVat = null
      r.netExcludingVat = null
    }
  }
  const payments = (d: Dataset) =>
    ['cash', 'card'].map((name) => ({
      name,
      totals: totals({
        sales: d.sales.filter((s) => s.method === name),
        corrections: d.corrections.filter((c) => c.method === name),
      }),
      share: d.sales.length
        ? (100 * d.sales.filter((s) => s.method === name).length) / d.sales.length
        : 0,
    }))
  const selectedDays = buckets(selected, 'day'),
    festivalDays = buckets(
      filtered(data, { ...f, from: settings.days[0]!.date, to: settings.days[3]!.date }),
      'day',
    ),
    goalDays = buckets(data, 'day')
  const days = Array.from({ length: daysBetween(f.from, f.to) }, (_, i) => {
    const day = shiftDay(f.from, i)
    return { day, totals: selectedDays.get(day) ?? empty() }
  })
  let cumulativeGross = 0,
    cumulativeNet = 0,
    cumulativeCount = 0
  const festival = settings.days.map((d) => {
    const v = festivalDays.get(d.date) ?? empty()
    cumulativeGross = add(cumulativeGross, v.gross)
    cumulativeNet = add(cumulativeNet, v.net)
    cumulativeCount += v.count
    return { day: d.date, totals: v, cumulativeGross, cumulativeNet, cumulativeCount }
  })
  const compareFrom = f.compareFrom || shiftDay(f.from, -daysBetween(f.from, f.to)),
    compareTo = f.compareTo || shiftDay(f.from, -1)
  const reference = filtered(data, { ...f, from: compareFrom, to: compareTo }),
    referenceTotals = totals(reference)
  const names = new Map<string, { name: string; at: string }>(),
    chains = new Map<string, Set<string>>(),
    received = new Map<string, string>()
  for (const row of [...data.sales, ...data.corrections]) {
    if (!names.has(row.terminalId) || row.at >= names.get(row.terminalId)!.at)
      names.set(row.terminalId, { name: row.tablet, at: row.at })
    const ids = chains.get(row.terminalId) ?? new Set<string>()
    ids.add(row.chainId)
    chains.set(row.terminalId, ids)
    if (
      'receivedAt' in row &&
      row.receivedAt &&
      row.receivedAt > (received.get(row.terminalId) ?? '')
    )
      received.set(row.terminalId, row.receivedAt)
  }
  const selectedByTablet = new Map<string, Dataset>()
  for (const s of selected.sales) {
    const group = selectedByTablet.get(s.terminalId) ?? { sales: [], corrections: [] }
    group.sales.push(s)
    selectedByTablet.set(s.terminalId, group)
  }
  for (const c of selected.corrections) {
    const group = selectedByTablet.get(c.terminalId) ?? { sales: [], corrections: [] }
    group.corrections.push(c)
    selectedByTablet.set(c.terminalId, group)
  }
  const tablets = [...names]
    .map(([id, n]) => {
      const d = selectedByTablet.get(id) ?? { sales: [], corrections: [] }
      const sync = (data.sync ?? []).filter((s) => chains.get(id)?.has(s.chainId)),
        dates = sync.flatMap((s) => (s.lastReceivedAt ? [s.lastReceivedAt] : [])).sort()
      const lastSyncAt = dates.at(-1) ?? null,
        lastReceivedAt = received.get(id) ?? null
      const discrepancy = sync.some(
        (s) => s.head !== null && s.receivedSequence !== null && s.head !== s.receivedSequence,
      )
      const delay = lastReceivedAt
        ? (Date.parse(generatedAt) - Date.parse(lastReceivedAt)) / 60000
        : null
      return {
        id,
        name: n.name,
        totals: totals(d),
        payments: payments(d),
        lastReceivedAt,
        lastSyncAt,
        pending: null,
        warning: discrepancy
          ? 'Écart entre tête et reçus lors de la lecture : à recontrôler, sans preuve de perte.'
          : delay !== null && delay > settings.staleMinutes
            ? `Aucune vente reçue depuis plus de ${settings.staleMinutes} min. Cela ne prouve pas une déconnexion.`
            : null,
      }
    })
    .sort((a, b) => b.totals.count - a.totals.count || a.name.localeCompare(b.name))
  const goals: Report['goals'] = []
  const addGoal = (label: string, target: number | null, actual: number) => {
    if (target)
      goals.push({
        label,
        target,
        actual,
        percent: (100 * actual) / target,
        remaining: Math.max(0, target - actual),
      })
  }
  if (f.from === f.to)
    addGoal(
      'Objectif du jour · brut, toutes caisses',
      settings.goals.daily,
      goalDays.get(f.from)?.gross ?? 0,
    )
  addGoal(
    'Objectif festival · brut, toutes caisses',
    settings.goals.festival,
    settings.days.reduce((sum, d) => add(sum, goalDays.get(d.date)?.gross ?? 0), 0),
  )
  selected.sales.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  selected.corrections.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  const pageCount = Math.max(1, Math.ceil(selected.sales.length / 50)),
    current = Math.min(page, pageCount),
    correctionPageCount = Math.max(1, Math.ceil(selected.corrections.length / 50)),
    currentCorrection = Math.min(correctionPage, correctionPageCount)
  const taxTotal = {
    gross: 0,
    excludingVat: 0,
    vat: 0,
    corrections: unallocated ? null : 0,
    correctionVat: unallocated ? null : 0,
    net: unallocated ? null : 0,
    netExcludingVat: unallocated ? null : 0,
    netVat: unallocated ? null : 0,
  }
  const selectedProducts: string[] = JSON.parse(f.productIds || '[]'),
    productQuery = (f.productQuery ?? '').toLocaleLowerCase('fr')
  const productRows = [...products.values()].filter(
    (p) =>
      (!selectedProducts.length || selectedProducts.includes(p.id)) &&
      p.names.some((n) => n.toLocaleLowerCase('fr').includes(productQuery)),
  )
  const visibleProductIds = new Set(productRows.map((p) => p.id))
  for (const r of taxes.values())
    for (const key of [
      'gross',
      'excludingVat',
      'vat',
      'corrections',
      'correctionVat',
      'net',
      'netExcludingVat',
      'netVat',
    ] as const) {
      if (taxTotal[key] !== null && r[key] !== null) taxTotal[key] = add(taxTotal[key]!, r[key]!)
    }
  return {
    generatedAt,
    filters: f,
    totals: {
      ...t,
      correctionCount: selected.corrections.length,
      legacyCount: selected.sales.filter((s) => s.legacy).length,
    },
    tablets,
    payments: payments(selected),
    days,
    hours: hourly(selected),
    festival,
    comparison: {
      from: compareFrom,
      to: compareTo,
      totals: referenceTotals,
      hours: hourly(reference),
      available: reference.sales.length > 0 || reference.corrections.length > 0,
      differences: (['gross', 'count', 'average', 'articles'] as const).map((key) => ({
        key,
        absolute: t[key] - referenceTotals[key],
        percent: referenceTotals[key]
          ? (100 * (t[key] - referenceTotals[key])) / referenceTotals[key]
          : null,
      })),
    },
    products: productRows.sort((a, b) => b.quantity - a.quantity || a.id.localeCompare(b.id)),
    productOptions: [
      ...new Map(
        [...data.sales]
          .sort((a, b) => a.at.localeCompare(b.at))
          .flatMap((s) =>
            s.lines.map((l) => [l.productId, { id: l.productId, name: l.name }] as const),
          ),
      ).values(),
    ],
    choices: [...choices.values()]
      .filter((c) => visibleProductIds.has(c.productId))
      .sort((a, b) => b.quantity - a.quantity),
    categories: {
      available: false,
      reason:
        'La catégorie historique n’est pas conservée dans les lignes scellées. Le catalogue actuel ne permet pas de réattribuer les anciennes ventes de façon fiable.',
    },
    tax: {
      rows: [...taxes.values()].sort((a, b) => a.rate - b.rate),
      total: taxTotal,
      complete: unallocated === 0,
      unallocatedCorrections: unallocated,
    },
    sales: selected.sales.slice((current - 1) * 50, current * 50).map((s) => ({
      ...publicSale(s),
      corrections: [...(associated.get(orderKey(s.chainId, s.id)) ?? [])]
        .map(publicCorrection)
        .sort((a, b) => a.at.localeCompare(b.at)),
      correctedCents: (associated.get(orderKey(s.chainId, s.id)) ?? []).reduce(
        (sum, c) => add(sum, c.cents),
        s.cents,
      ),
    })),
    corrections: selected.corrections
      .slice((currentCorrection - 1) * 50, currentCorrection * 50)
      .map(publicCorrection),
    saleCount: selected.sales.length,
    page: current,
    pageCount,
    correctionCount: selected.corrections.length,
    correctionPage: currentCorrection,
    correctionPageCount: correctionPageCount,
    goals,
    warnings: [
      ...(unallocated
        ? [
            `${unallocated} correction(s) ne peuvent pas être attribuées précisément aux produits et à la TVA : indicateurs nets incomplets.`,
          ]
        : []),
      ...(selected.sales.some((s) => s.legacy)
        ? ['Des ventes historiques importées n’ont pas de date de réception disponible.']
        : []),
    ],
  }
}
