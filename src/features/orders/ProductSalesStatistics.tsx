import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  calculateProductSalesStatistics,
  listProductsForSalesStatistics,
  localDateInputValue,
  localDateRangePeriod,
  localDayPeriod,
  type ProductSalesPeriod,
} from '../../services/productSalesStatistics'
import type { Product } from '../../types/catalog'
import type { Order } from '../../types/order'
import type { CorrectionLedgerEntry } from '../../types/salesLedger'
import { formatMoney } from '../../utils/money'

type PeriodMode = 'today' | 'date' | 'range'

type Props = {
  orders: Order[]
  corrections: CorrectionLedgerEntry[]
  products: Product[]
  now?: Date
}

const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

export function ProductSalesStatistics({ orders, corrections, products, now = new Date() }: Props) {
  const today = localDateInputValue(now)
  const [periodMode, setPeriodMode] = useState<PeriodMode>('today')
  const [date, setDate] = useState(today)
  const [rangeStart, setRangeStart] = useState(today)
  const [rangeEnd, setRangeEnd] = useState(today)
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string> | null>(null)
  const [search, setSearch] = useState('')

  const productOptions = useMemo(
    () => listProductsForSalesStatistics(products, orders),
    [orders, products],
  )
  const effectiveSelection = useMemo(
    () => selectedProductIds ?? new Set(productOptions.map(({ id }) => id)),
    [productOptions, selectedProductIds],
  )
  const period = useMemo(
    () => resolvePeriod(periodMode, today, date, rangeStart, rangeEnd),
    [date, periodMode, rangeEnd, rangeStart, today],
  )
  const statistics = useMemo(
    () =>
      period
        ? calculateProductSalesStatistics({
            orders,
            corrections,
            products,
            selectedProductIds: effectiveSelection,
            period,
          })
        : null,
    [corrections, effectiveSelection, orders, period, products],
  )
  const normalizedSearch = search.trim().toLocaleLowerCase('fr-FR')
  const visibleProducts = productOptions.filter(({ name }) =>
    name.toLocaleLowerCase('fr-FR').includes(normalizedSearch),
  )
  const allSelected =
    productOptions.length > 0 && productOptions.every(({ id }) => effectiveSelection.has(id))

  const toggleProduct = (productId: string) => {
    setSelectedProductIds((current) => {
      const next = new Set(current ?? productOptions.map(({ id }) => id))
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"
      aria-label="Statistiques des produits"
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(17rem,0.75fr)_minmax(0,2fr)]">
        <aside className="space-y-5">
          <fieldset>
            <legend className="text-lg font-black">Période</legend>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  ['today', 'Aujourd’hui'],
                  ['date', 'Une date'],
                  ['range', 'Une plage'],
                ] as const
              ).map(([mode, label]) => (
                <Button
                  key={mode}
                  className="min-h-14 px-2"
                  variant={periodMode === mode ? 'primary' : 'secondary'}
                  aria-pressed={periodMode === mode}
                  onClick={() => setPeriodMode(mode)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {periodMode === 'date' ? (
              <DateField label="Date" value={date} onChange={setDate} />
            ) : null}
            {periodMode === 'range' ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <DateField label="Du" value={rangeStart} onChange={setRangeStart} />
                <DateField label="Au" value={rangeEnd} onChange={setRangeEnd} />
              </div>
            ) : null}
            {!period ? (
              <p className="mt-2 font-bold text-rose-900" role="alert">
                Choisissez une période valide. La date de fin doit suivre la date de début.
              </p>
            ) : null}
          </fieldset>

          <fieldset>
            <legend className="text-lg font-black">Produits</legend>
            <div className="mt-2 flex gap-2">
              <Button
                className="min-h-12 flex-1 px-3"
                variant={allSelected ? 'primary' : 'secondary'}
                onClick={() => setSelectedProductIds(new Set(productOptions.map(({ id }) => id)))}
              >
                Tout sélectionner
              </Button>
              <Button
                className="min-h-12 flex-1 px-3"
                disabled={effectiveSelection.size === 0}
                onClick={() => setSelectedProductIds(new Set())}
              >
                Tout désélectionner
              </Button>
            </div>
            {productOptions.length > 6 ? (
              <label className="mt-3 block font-bold" htmlFor="product-statistics-search">
                Rechercher
                <input
                  id="product-statistics-search"
                  type="search"
                  className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            ) : null}
            <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto pr-1">
              {visibleProducts.map((product) => {
                const selected = effectiveSelection.has(product.id)
                return (
                  <button
                    key={product.id}
                    type="button"
                    className={`min-h-12 rounded-[8px] border px-3 py-2 text-left font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${selected ? 'border-[#1f6a4b] bg-emerald-50 text-emerald-950' : 'border-stone-300 bg-white text-stone-800'}`}
                    aria-pressed={selected}
                    onClick={() => toggleProduct(product.id)}
                  >
                    <span aria-hidden="true">{selected ? '✓ ' : ''}</span>
                    {product.name}
                  </button>
                )
              })}
              {productOptions.length === 0 ? (
                <p className="font-bold text-stone-700">Aucun produit disponible.</p>
              ) : visibleProducts.length === 0 ? (
                <p className="font-bold text-stone-700">Aucun produit trouvé.</p>
              ) : null}
            </div>
          </fieldset>
        </aside>

        <section aria-labelledby="product-statistics-title">
          <h3 id="product-statistics-title" className="text-2xl font-black">
            Ventes par produit
          </h3>
          <p className="mt-1 text-sm font-bold text-stone-600">
            Les annulations sont exclues et les remboursements par article sont déduits.
          </p>

          {!period ? null : effectiveSelection.size === 0 ? (
            <p className="mt-5 border border-stone-300 bg-stone-50 p-4 font-bold text-stone-700">
              Sélectionnez au moins un produit.
            </p>
          ) : statistics ? (
            <>
              {!statistics.hasSales ? (
                <p className="mt-5 border border-stone-300 bg-stone-50 p-4 font-bold text-stone-700">
                  Aucune vente sur cette période.
                </p>
              ) : null}
              {statistics.hasUnallocatedCorrections ? (
                <p
                  className="mt-4 border border-amber-400 bg-amber-50 p-3 font-bold text-amber-950"
                  role="status"
                >
                  Certaines anciennes corrections ne précisent pas les articles concernés. Les
                  produits touchés sont indiqués comme indisponibles pour éviter un résultat faux.
                </p>
              ) : null}
              <div className="mt-4 overflow-x-auto border-y border-stone-300">
                <table className="w-full min-w-[700px] border-collapse text-left">
                  <thead className="bg-stone-100">
                    <tr>
                      <ColumnHeader>Produit</ColumnHeader>
                      <ColumnHeader numeric>Quantité vendue</ColumnHeader>
                      <ColumnHeader numeric>Chiffre d’affaires</ColumnHeader>
                      <ColumnHeader numeric>Prix moyen</ColumnHeader>
                      <ColumnHeader numeric>Part des ventes</ColumnHeader>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200">
                    {statistics.rows.map((row) => (
                      <tr key={row.productId}>
                        <th className="px-3 py-3 font-black" scope="row">
                          {row.productName}
                        </th>
                        {row.complete ? (
                          <>
                            <Cell>{row.quantity}</Cell>
                            <Cell>{formatMoney(row.revenueCents)}</Cell>
                            <Cell>
                              {row.averagePriceCents === null
                                ? '—'
                                : formatMoney(row.averagePriceCents)}
                            </Cell>
                            <Cell>
                              {row.quantitySharePercent === null
                                ? '—'
                                : formatPercent(row.quantitySharePercent)}
                            </Cell>
                          </>
                        ) : (
                          <td className="px-3 py-3 text-right font-bold text-amber-900" colSpan={4}>
                            Indisponible — correction sans détail article
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function resolvePeriod(
  mode: PeriodMode,
  today: string,
  date: string,
  rangeStart: string,
  rangeEnd: string,
): ProductSalesPeriod | null {
  if (mode === 'today') return localDayPeriod(today)
  if (mode === 'date') return localDayPeriod(date)
  return localDateRangePeriod(rangeStart, rangeEnd)
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="mt-3 block font-bold">
      {label}
      <input
        type="date"
        className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function ColumnHeader({ children, numeric = false }: { children: string; numeric?: boolean }) {
  return (
    <th className={`px-3 py-3 font-black ${numeric ? 'text-right' : ''}`} scope="col">
      {children}
    </th>
  )
}

function Cell({ children }: { children: string | number }) {
  return <td className="px-3 py-3 text-right font-bold tabular-nums">{children}</td>
}

function formatPercent(value: number): string {
  return `${percentFormatter.format(value)} %`
}
