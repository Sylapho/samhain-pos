import { parseStrictJson } from '../json.ts'
import { validateOrder } from '../ledger/business.ts'
import { add, array, date, integer, object, text } from '../ledger/validation.ts'
import type { LedgerEvent, Sale } from '../persistence/model.ts'

import type { SaleRow, CorrectionRow, Dataset, Filters, Totals, Report } from './types.ts'
export type { Filters } from './types.ts'

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export const parisDay = (at: string) => dayFormatter.format(new Date(at))
function tabletName(value: unknown, fallback: string): string {
  if (!value) return fallback
  const t = object(value)
  return `${text(t.displayName)} (${text(t.terminalCode)})`
}
function saleRow(
  payload: string,
  terminalId: string,
  legacy: boolean,
  receivedAt: string | null,
): SaleRow {
  const p = object(parseStrictJson(payload))
  const o = validateOrder(legacy ? p : p.order, terminalId)
  return {
    id: text(o.id),
    number: text(o.orderNumber),
    receipt: text(o.receiptNumber),
    terminalId,
    tablet: tabletName(
      o.terminal,
      typeof o.registerName === 'string' ? o.registerName : terminalId,
    ),
    at: date(o.paidAt),
    receivedAt,
    method: text(o.paymentMethod),
    cents: integer(o.totalCents, 0),
    legacy,
    lines: array(o.items).map((value) => {
      const l = object(value)
      const removed = array(l.removedIngredientIds)
      const details = array(l.options).map((v) => text(object(v).optionName))
      for (const ingredient of array(l.ingredients)) {
        const i = object(ingredient)
        if (removed.includes(i.id)) details.push(`Sans ${text(i.name)}`)
      }
      if (l.variant) details.unshift(text(object(l.variant).name))
      if (l.note) details.push(text(l.note))
      return {
        name: text(l.name),
        quantity: integer(l.quantity, 1),
        unitPriceCents: integer(l.unitPriceCents, 0),
        details,
      }
    }),
  }
}

// A sealed sale is read from the ledger only; its reservation in sales must not count twice.
export function dataset(events: LedgerEvent[], legacy: Sale[]): Dataset {
  const sales: SaleRow[] = []
  const corrections: CorrectionRow[] = []
  for (const e of events) {
    if (e.kind === 'sale')
      sales.push(
        saleRow(e.payloadCanonical, e.sourceTerminalId, false, e.serverReceivedAt.toISOString()),
      )
    else if (e.kind === 'correction') {
      const p = object(parseStrictJson(e.payloadCanonical))
      const c = object(p.correction)
      corrections.push({
        id: e.eventId,
        order: text(c.originalOrderNumber),
        receipt: text(c.originalReceiptNumber),
        terminalId: e.sourceTerminalId,
        tablet: tabletName(object(p.source).terminal, e.sourceTerminalId),
        at: date(e.recordedAt),
        cents: integer(c.amountDeltaCents),
        method: text(c.paymentMethod),
        type: text(c.type),
        reason: text(c.reason),
      })
    }
  }
  for (const s of legacy)
    if (s.type === 'legacy') sales.push(saleRow(s.payloadCanonical, s.sourceTerminalId, true, null))
  return { sales, corrections }
}
export function filtered(data: Dataset, f: Filters): Dataset {
  const matches = (r: { at: string; terminalId: string; method: string }) => {
    const d = parisDay(r.at)
    return (
      (!f.from || d >= f.from) &&
      (!f.to || d <= f.to) &&
      (!f.terminal || r.terminalId === f.terminal) &&
      (!f.payment || r.method === f.payment)
    )
  }
  // Search affects both original sales and their corrections consistently by order number.
  const q = f.search.trim().toLocaleLowerCase('fr')
  return {
    sales: data.sales.filter(
      (r) => matches(r) && (!q || `${r.number} ${r.receipt}`.toLocaleLowerCase('fr').includes(q)),
    ),
    corrections: data.corrections.filter(
      (r) => matches(r) && (!q || `${r.order} ${r.receipt}`.toLocaleLowerCase('fr').includes(q)),
    ),
  }
}
const empty = (): Totals => ({ count: 0, gross: 0, corrections: 0, net: 0 })
function accumulate(t: Totals, cents: number, sale: boolean) {
  if (sale) {
    t.count++
    t.gross = add(t.gross, cents)
  } else t.corrections = add(t.corrections, cents)
  t.net = add(t.gross, t.corrections)
}
export function report(data: Dataset, f: Filters, page: number): Report {
  const selected = filtered(data, f)
  const totals = empty()
  const tablets = new Map<string, Report['tablets'][number]>()
  const namesAt = new Map<string, string>()
  // Keep every historical tablet selectable, including tablets without sales in this period.
  for (const r of [...data.sales, ...data.corrections]) {
    const previous = tablets.get(r.terminalId)
    const received = 'receivedAt' in r ? r.receivedAt : null
    tablets.set(r.terminalId, {
      id: r.terminalId,
      name:
        !namesAt.has(r.terminalId) || r.at >= namesAt.get(r.terminalId)!
          ? r.tablet
          : previous!.name,
      totals: previous?.totals ?? empty(),
      lastReceivedAt:
        received && (!previous?.lastReceivedAt || received > previous.lastReceivedAt)
          ? received
          : (previous?.lastReceivedAt ?? null),
    })
    if (!namesAt.has(r.terminalId) || r.at >= namesAt.get(r.terminalId)!)
      namesAt.set(r.terminalId, r.at)
  }
  const payments = new Map<string, Totals>([
    ['cash', empty()],
    ['card', empty()],
  ])
  const days = new Map<string, Totals>()
  for (const [rows, sale] of [
    [selected.sales, true],
    [selected.corrections, false],
  ] as const) {
    for (const r of rows) {
      const day = parisDay(r.at)
      const d = days.get(day) ?? empty()
      const payment = payments.get(r.method) ?? empty()
      accumulate(totals, r.cents, sale)
      accumulate(tablets.get(r.terminalId)!.totals, r.cents, sale)
      accumulate(d, r.cents, sale)
      accumulate(payment, r.cents, sale)
      days.set(day, d)
      payments.set(r.method, payment)
    }
  }
  const products = new Map<string, { name: string; quantity: number; cents: number }>()
  for (const s of selected.sales)
    for (const l of s.lines) {
      const p = products.get(l.name) ?? { name: l.name, quantity: 0, cents: 0 }
      p.quantity = add(p.quantity, l.quantity)
      p.cents = add(p.cents, integer(l.quantity * l.unitPriceCents))
      products.set(l.name, p)
    }
  selected.sales.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  selected.corrections.sort((a, b) => b.at.localeCompare(a.at))
  const pageCount = Math.max(1, Math.ceil(selected.sales.length / 50))
  const current = Math.min(page, pageCount)
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      average: totals.count ? Math.round(totals.gross / totals.count) : 0,
      correctionCount: selected.corrections.length,
      legacyCount: selected.sales.filter((s) => s.legacy).length,
    },
    tablets: [...tablets.values()].sort(
      (a, b) => b.totals.count - a.totals.count || a.name.localeCompare(b.name),
    ),
    payments: [...payments].map(([name, totals]) => ({ name, totals })),
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, totals]) => ({ day, totals })),
    products: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    sales: selected.sales.slice((current - 1) * 50, current * 50),
    corrections: selected.corrections.slice(0, 50),
    saleCount: selected.sales.length,
    page: current,
    pageCount,
  }
}
export function salesCsv(data: Dataset, filters: Filters): string {
  const cell = (value: string | number) => {
    const s = String(value)
    return `"${(/^[=+\-@\t\r\n]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`
  }
  const rows = filtered(data, filters).sales.sort((a, b) => b.at.localeCompare(a.at))
  return (
    '\uFEFF' +
    [
      [
        'Commande',
        'Reçu',
        'Tablette',
        'Date UTC',
        'Paiement',
        'Montant brut EUR',
        'Import historique',
      ],
      ...rows.map((r) => [
        r.number,
        r.receipt,
        r.tablet,
        r.at,
        r.method === 'cash' ? 'Espèces' : 'Carte',
        (r.cents / 100).toFixed(2).replace('.', ','),
        r.legacy ? 'Oui' : 'Non',
      ]),
    ]
      .map((row) => row.map(cell).join(';'))
      .join('\r\n')
  )
}
