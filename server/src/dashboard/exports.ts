import { add, multiply } from '../ledger/validation.ts'
import { filtered } from './report.ts'
import { buildReport, orderKey } from './analytics.ts'
import type { Dataset, Filters, DashboardSettings, ExportKind, Report } from './types.ts'
type Cell = string | number | null | { numeric: string }
function cell(value: Cell) {
  if (typeof value === 'number' || (value !== null && typeof value === 'object'))
    return `"${typeof value === 'number' ? String(value) : value.numeric}"`
  const s = value === null ? 'Indisponible' : String(value)
  return `"${(/^[\s=+\-@]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`
}
function money(cents: number | null): Cell {
  if (cents === null) return null
  const n = BigInt(cents),
    abs = n < 0n ? -n : n
  return { numeric: `${n < 0n ? '-' : ''}${abs / 100n},${String(abs % 100n).padStart(2, '0')}` }
}
const local = (at: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(at))
function* rows(
  data: Dataset,
  f: Filters,
  settings: DashboardSettings,
  kind: ExportKind,
  prepared?: Report,
): Generator<Cell[]> {
  const selected = filtered(data, f)
  const selectedProducts: string[] = JSON.parse(f.productIds || '[]')
  const label = (method: string) => (method === 'cash' ? 'Espèces' : 'Carte')
  if (kind === 'orders' || kind === 'lines') {
    const corrections = new Map<string, number>()
    for (const c of data.corrections) {
      const k = orderKey(c.chainId, c.originalId)
      corrections.set(k, add(corrections.get(k) ?? 0, c.cents))
    }
    yield kind === 'orders'
      ? [
          'Commande',
          'Reçu',
          'Tablette',
          'Paiement UTC',
          'Paiement Europe/Paris',
          'Paiement',
          'Brut EUR',
          'Montant après toutes corrections EUR',
          'Historique',
        ]
      : [
          'Commande',
          'Tablette',
          'Paiement UTC',
          'Paiement Europe/Paris',
          'ID produit',
          'Nom historique',
          'Quantité brute',
          'Prix unitaire TTC EUR',
          'Total TTC EUR',
          'TVA %',
          'Variante',
          'Options et retraits',
        ]
    for (const s of [...selected.sales].sort((a, b) => b.at.localeCompare(a.at))) {
      if (kind === 'orders')
        yield [
          s.number,
          s.receipt,
          s.tablet,
          s.at,
          local(s.at),
          label(s.method),
          money(s.cents),
          money(add(s.cents, corrections.get(orderKey(s.chainId, s.id)) ?? 0)),
          s.legacy ? 'Oui' : 'Non',
        ]
      else
        for (const l of s.lines)
          if (!selectedProducts.length || selectedProducts.includes(l.productId))
            yield [
              s.number,
              s.tablet,
              s.at,
              local(s.at),
              l.productId,
              l.name,
              l.quantity,
              money(l.unitPriceCents),
              money(multiply(l.quantity, l.unitPriceCents)),
              l.vatRate,
              l.variant?.name ?? '',
              l.details.join(' · '),
            ]
    }
    return
  }
  if (kind === 'corrections') {
    yield [
      'Commande',
      'Reçu',
      'Tablette',
      'Correction UTC',
      'Correction Europe/Paris',
      'Type',
      'Motif',
      'Paiement',
      'Correction EUR',
      'Produits connus',
    ]
    for (const c of [...selected.corrections].sort((a, b) => b.at.localeCompare(a.at)))
      yield [
        c.order,
        c.receipt,
        c.tablet,
        c.at,
        local(c.at),
        c.type,
        c.reason,
        label(c.method),
        money(c.cents),
        c.refundLines?.map((l) => `${l.quantity} × ${l.productName}`).join(' · ') ?? 'Indisponible',
      ]
    return
  }
  const r = prepared ?? buildReport(data, f, 1, settings)
  if (kind === 'products') {
    yield [
      'ID produit',
      'Nom historique',
      'Quantité brute',
      'Quantité nette',
      'Brut EUR',
      'Net EUR',
      'Commandes',
      'Part quantité %',
      'Part brut %',
    ]
    for (const p of r.products)
      yield [
        p.id,
        p.name,
        p.quantity,
        p.netQuantity,
        money(p.cents),
        money(p.netCents),
        p.orderCount,
        p.quantityShare.toFixed(2).replace('.', ','),
        p.revenueShare.toFixed(2).replace('.', ','),
      ]
  } else if (kind === 'categories') {
    yield ['Statut', 'Motif']
    yield ['Indisponible', r.categories.reason]
  } else if (kind === 'tablets') {
    yield [
      'Tablette',
      'Commandes',
      'Articles bruts',
      'Brut EUR',
      'Corrections EUR',
      'Net EUR',
      'Panier moyen EUR',
      'Dernière vente reçue UTC',
      'Dernière activité de synchronisation UTC',
      'Événements en attente',
    ]
    for (const t of r.tablets)
      yield [
        t.name,
        t.totals.count,
        t.totals.articles,
        money(t.totals.gross),
        money(t.totals.corrections),
        money(t.totals.net),
        money(t.totals.average),
        t.lastReceivedAt,
        t.lastSyncAt,
        null,
      ]
  } else if (kind === 'days') {
    yield [
      'Date Europe/Paris',
      'Commandes',
      'Articles bruts',
      'Brut EUR',
      'Corrections EUR',
      'Net EUR',
      'Panier moyen EUR',
    ]
    for (const d of r.days)
      yield [
        d.day,
        d.totals.count,
        d.totals.articles,
        money(d.totals.gross),
        money(d.totals.corrections),
        money(d.totals.net),
        money(d.totals.average),
      ]
  } else {
    yield [
      'Taux TVA %',
      'Ventes TTC EUR',
      'Ventes HT EUR',
      'TVA ventes EUR',
      'Corrections TTC EUR',
      'Corrections TVA EUR',
      'Net TTC EUR',
      'Net HT EUR',
      'Net TVA EUR',
      'Statut',
    ]
    for (const t of r.tax.rows)
      yield [
        t.rate,
        money(t.gross),
        money(t.excludingVat),
        money(t.vat),
        money(t.corrections),
        money(t.correctionVat),
        money(t.net),
        money(t.netExcludingVat),
        money(t.netVat),
        r.tax.complete ? 'Complet' : 'Incomplet : corrections non attribuables',
      ]
    yield [
      'TOTAL',
      money(r.tax.total.gross),
      money(r.tax.total.excludingVat),
      money(r.tax.total.vat),
      money(r.tax.total.corrections),
      money(r.tax.total.correctionVat),
      money(r.tax.total.net),
      money(r.tax.total.netExcludingVat),
      money(r.tax.total.netVat),
      'Consultation, sans certification comptable',
    ]
  }
}
export function* csvChunks(
  data: Dataset,
  f: Filters,
  settings: DashboardSettings,
  kind: ExportKind,
  prepared?: Report,
): Generator<string> {
  yield '\uFEFF'
  for (const row of rows(data, f, settings, kind, prepared)) yield row.map(cell).join(';') + '\r\n'
}
export function prepareExport(data: Dataset, f: Filters, settings: DashboardSettings): Report {
  const summary = buildReport(data, f, 1, settings),
    corrections = new Map<string, number>()
  for (const c of data.corrections) {
    const key = orderKey(c.chainId, c.originalId)
    corrections.set(key, add(corrections.get(key) ?? 0, c.cents))
  }
  for (const s of data.sales) add(s.cents, corrections.get(orderKey(s.chainId, s.id)) ?? 0)
  return summary
}
export function salesCsv(data: Dataset, f: Filters, settings: DashboardSettings): string {
  return [...csvChunks(data, f, settings, 'orders')].join('')
}
