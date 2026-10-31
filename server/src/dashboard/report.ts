import { parseStrictJson } from '../json.ts'
import { validateOrder, validatePayload } from '../ledger/business.ts'
import { array, date, integer, object, text } from '../ledger/validation.ts'
import type { LedgerEvent, Sale } from '../persistence/model.ts'

import type { SaleRow, CorrectionRow, Dataset, Filters } from './types.ts'
export { buildReport as report } from './analytics.ts'
export { salesCsv } from './exports.ts'
export type { Filters } from './types.ts'

import { parisDay, parisHour } from './periods.ts'
export { parisDay } from './periods.ts'
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
  chainId: string,
): SaleRow {
  const p = object(parseStrictJson(payload))
  const o = validateOrder(legacy ? p : p.order, terminalId)
  const at = date(o.paidAt)
  return {
    id: text(o.id),
    chainId,
    number: text(o.orderNumber),
    receipt: text(o.receiptNumber),
    terminalId,
    tablet: tabletName(
      o.terminal,
      typeof o.registerName === 'string' ? o.registerName : terminalId,
    ),
    at,
    day: parisDay(at),
    hour: parisHour(at),
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
        lineId: text(l.lineId),
        productId: text(l.productId),
        vatRate: integer(l.vatRate),
        variant: l.variant
          ? { id: text(object(l.variant).id), name: text(object(l.variant).name) }
          : null,
        options: array(l.options).map((value) => {
          const opt = object(value)
          return {
            id: text(opt.optionId),
            name: text(opt.optionName),
            groupId: text(opt.groupId),
            supplement: integer(opt.priceDeltaCents) > 0,
          }
        }),
        removed: array(l.ingredients)
          .map(object)
          .filter((i) => removed.includes(i.id))
          .map((i) => ({ id: text(i.id), name: text(i.name) })),
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
        saleRow(
          e.payloadCanonical,
          e.sourceTerminalId,
          false,
          e.serverReceivedAt.toISOString(),
          e.chainId,
        ),
      )
    else if (e.kind === 'correction') {
      const p = object(parseStrictJson(e.payloadCanonical))
      validatePayload(p)
      const c = object(p.correction)
      corrections.push({
        id: e.eventId,
        chainId: e.chainId,
        originalId: text(c.originalOrderId),
        refundLines: c.refundLines
          ? array(c.refundLines).map((value) => {
              const r = object(value)
              return {
                originalLineId: text(r.originalLineId),
                productId: text(r.productId),
                productName: text(r.productName),
                quantity: integer(r.quantity, 1),
                unitPriceCents: integer(r.unitPriceCents, 0),
                vatRate: integer(r.vatRate),
                grossCents: integer(r.grossCents, 0),
                vatCents: integer(r.vatCents, 0),
              }
            })
          : null,
        order: text(c.originalOrderNumber),
        receipt: text(c.originalReceiptNumber),
        terminalId: e.sourceTerminalId,
        tablet: tabletName(object(p.source).terminal, e.sourceTerminalId),
        at: date(e.recordedAt),
        day: parisDay(e.recordedAt),
        hour: parisHour(e.recordedAt),
        cents: integer(c.amountDeltaCents),
        method: text(c.paymentMethod),
        type: text(c.type),
        reason: text(c.reason),
      })
    }
  }
  for (const s of legacy)
    if (s.type === 'legacy')
      sales.push(saleRow(s.payloadCanonical, s.sourceTerminalId, true, null, s.chainId))
  return { sales, corrections }
}
export function filtered(data: Dataset, f: Filters): Dataset {
  const selectedIds: string[] = JSON.parse(f.productIds || '[]')
  const correctedIds = new Set(
    data.corrections.map((c) => JSON.stringify([c.chainId, c.originalId])),
  )
  const orderMatch = (r: SaleRow) => {
    const corrected = correctedIds.has(JSON.stringify([r.chainId, r.id]))
    return (
      (!selectedIds.length || r.lines.some((l) => selectedIds.includes(l.productId))) &&
      (f.corrected !== 'with' || corrected) &&
      (f.corrected !== 'without' || !corrected)
    )
  }
  const matches = (r: { day: string; terminalId: string; method: string }) => {
    const d = r.day
    return (
      (!f.from || d >= f.from) &&
      (!f.to || d <= f.to) &&
      (!f.terminal || r.terminalId === f.terminal) &&
      (!f.payment || r.method === f.payment)
    )
  }
  const q = f.search.trim().toLocaleLowerCase('fr')
  const search = (s: SaleRow) =>
    !q ||
    `${s.number} ${s.receipt} ${s.lines.map((l) => l.name).join(' ')}`
      .toLocaleLowerCase('fr')
      .includes(q)
  const originals = new Map(data.sales.map((s) => [JSON.stringify([s.chainId, s.id]), s]))
  return {
    sales: data.sales.filter((r) => matches(r) && search(r) && orderMatch(r)),
    corrections: data.corrections.filter((r) => {
      const original = originals.get(JSON.stringify([r.chainId, r.originalId]))
      return (
        matches(r) &&
        (original
          ? orderMatch(original) && search(original)
          : !selectedIds.length &&
            f.corrected !== 'without' &&
            (!q || `${r.order} ${r.receipt}`.toLocaleLowerCase('fr').includes(q)))
      )
    }),
  }
}
