import ExcelJS from 'exceljs'
import type { LedgerEvent, Sale } from '../persistence/model.ts'
import { parseStrictJson } from '../json.ts'
import { array, integer, object, text } from '../ledger/validation.ts'
import { filtered } from './report.ts'
import type { Dataset, Filters } from './types.ts'

const euro = (cents: number) => cents / 100
const vat = (gross: number, rate: number) => Math.round((gross * rate) / (100 + rate))
const paris = (at: string) => new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date(at))
const method = (value: string) => value === 'cash' ? 'Espèces' : 'Carte bancaire'
const detail = (line: Record<string, unknown>) => {
  const parts = []
  if (line.variant) parts.push(text(object(line.variant).name))
  for (const value of array(line.options)) parts.push(text(object(value).optionName))
  if (line.note) parts.push(text(line.note))
  return parts.join(' · ')
}

export async function accountingXlsx(
  events: LedgerEvent[],
  legacy: Extract<Sale, { type: 'legacy' }>[],
  data: Dataset,
  filters: Filters,
): Promise<Buffer> {
  const selected = filtered(data, filters)
  const saleIds = new Set(selected.sales.map((sale) => sale.id))
  const correctionIds = new Set(selected.corrections.map((correction) => correction.id))
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Détail comptable', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    'Opération\nType', 'Commande\nNum.', 'Reçu\nNum.',
    'Vente\nPoint de vente', 'Achat\nDate Europe/Paris', 'Achat\nDate UTC',
    'Achat\nMode paiement', 'Produit\nNom historique',
    'Produit\nVariante', 'Produit\nOptions et notes', 'Quantité signée',
    'Prix unitaire\nTTC EUR', 'Montant de l’opération\nTTC EUR', 'Taux TVA',
    'TVA de l’opération\nEUR', 'Montant de l’opération\nHT EUR', 'Données\nStatut',
  ].map((header, index) => ({ header, key: String(index), width: index === 7 || index === 9 ? 28 : 19 }))
  const header = sheet.getRow(1)
  header.height = 38
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263238' } }
  header.alignment = { vertical: 'middle', wrapText: true }
  sheet.autoFilter = 'A1:Q1'
  const rows: (string | number | null)[][] = []
  const add = (values: (string | number | null)[]) => rows.push(values)
  const append = (values: (string | number | null)[]) => {
    const row = sheet.addRow(values)
    for (const col of [12, 13, 15, 16]) row.getCell(col).numFmt = '#,##0.00;[Red]-#,##0.00'
    row.getCell(14).numFmt = '0.0%'
  }
  const saleById = new Map(selected.sales.map((sale) => [sale.id, sale]))
  for (const event of events) {
    if (event.kind !== 'sale') continue
    const payload = object(parseStrictJson(event.payloadCanonical))
    const order = object(payload.order)
    const id = text(order.id)
    if (!saleIds.has(id)) continue
    const sale = saleById.get(id)!
    for (const value of array(order.items)) {
      const line = object(value)
      const quantity = integer(line.quantity, 1)
      const gross = integer(line.unitPriceCents, 0) * quantity
      const rate = Number(line.vatRate)
      const tax = vat(gross, rate)
      add(['Vente', sale.number, sale.receipt, sale.tablet,
        paris(sale.at), sale.at, method(sale.method), text(line.name),
        line.variant ? text(object(line.variant).name) : '', detail(line), quantity,
        euro(integer(line.unitPriceCents, 0)), euro(gross), rate / 100,
        euro(tax), euro(gross - tax), line.dataConfidence === 'confirmed' ? 'Confirmées' : 'Temporaires'])
    }
  }
  for (const entry of legacy) {
    const order = object(parseStrictJson(entry.payloadCanonical))
    const id = text(order.id)
    if (!saleIds.has(id)) continue
    const sale = saleById.get(id)!
    for (const value of array(order.items)) {
      const line = object(value)
      const quantity = integer(line.quantity, 1)
      const gross = integer(line.unitPriceCents, 0) * quantity
      const rate = Number(line.vatRate)
      const tax = vat(gross, rate)
      add(['Vente historique', sale.number, sale.receipt, sale.tablet,
        paris(sale.at), sale.at, method(sale.method), text(line.name),
        line.variant ? text(object(line.variant).name) : '', detail(line), quantity,
        euro(integer(line.unitPriceCents, 0)), euro(gross), rate / 100,
        euro(tax), euro(gross - tax), line.dataConfidence === 'confirmed' ? 'Confirmées' : 'Temporaires'])
    }
  }
  const correctionById = new Map(selected.corrections.map((correction) => [correction.id, correction]))
  const originalOrders = new Map<string, Record<string, unknown>>()
  for (const event of events) if (event.kind === 'sale') {
    const order = object(object(parseStrictJson(event.payloadCanonical)).order)
    originalOrders.set(text(order.id), order)
  }
  for (const entry of legacy) {
    const order = object(parseStrictJson(entry.payloadCanonical))
    originalOrders.set(text(order.id), order)
  }
  for (const event of events) {
    if (event.kind !== 'correction' || !correctionIds.has(event.eventId)) continue
    const payload = object(parseStrictJson(event.payloadCanonical))
    const correction = object(payload.correction)
    const summary = correctionById.get(event.eventId)!
    const lines = correction.refundLines ? array(correction.refundLines) : []
    if (lines.length) {
      for (const value of lines) {
        const line = object(value)
        const gross = -integer(line.grossCents, 0)
        const tax = -integer(line.vatCents, 0)
        add(['Remboursement', summary.order, summary.receipt, summary.tablet,
          paris(summary.at), summary.at, method(summary.method),
          text(line.productName), '', text(correction.reason), -integer(line.quantity, 1),
          euro(integer(line.unitPriceCents, 0)), euro(gross), Number(line.vatRate) / 100,
          euro(tax), euro(gross - tax), 'Confirmées'])
      }
    } else if (correction.type === 'cancellation' && originalOrders.has(text(correction.originalOrderId))) {
      const original = originalOrders.get(text(correction.originalOrderId))!
      for (const value of array(original.items)) {
        const line = object(value)
        const quantity = integer(line.quantity, 1)
        const gross = integer(line.unitPriceCents, 0) * quantity
        const rate = Number(line.vatRate)
        const tax = vat(gross, rate)
        add(['Annulation', summary.order, summary.receipt, summary.tablet,
          paris(summary.at), summary.at, method(summary.method),
          text(line.name), line.variant ? text(object(line.variant).name) : '', detail(line),
          -quantity, euro(integer(line.unitPriceCents, 0)), -euro(gross), rate / 100,
          -euro(tax), -euro(gross - tax), 'Confirmées'])
      }
    } else {
      add([text(correction.type), summary.order, summary.receipt, summary.tablet,
        paris(summary.at), summary.at, method(summary.method),
        '', '', text(correction.reason), null, null, euro(summary.cents), null, null, null,
        'TVA non ventilée'])
    }
  }
  // Keep product lines together and order operations by their actual timestamp.
  rows.sort((a, b) => String(a[5]).localeCompare(String(b[5])))
  rows.forEach(append)
  const bytes = await book.xlsx.writeBuffer()
  return Buffer.from(bytes)
}
