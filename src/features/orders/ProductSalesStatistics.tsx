import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  calculateProductSalesStatistics,
  listProductsForSalesStatistics,
} from '../../services/productSalesStatistics'
import type { Product } from '../../types/catalog'
import type { Order } from '../../types/order'
import type { CorrectionLedgerEntry } from '../../types/salesLedger'
import { formatMoney } from '../../utils/money'

type Props = {
  orders: Order[]
  corrections: CorrectionLedgerEntry[]
  products: Product[]
  now?: Date
}

const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

export function ProductSalesStatistics({ orders, corrections, products, now }: Props) {
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string> | null>(null)
  const [search, setSearch] = useState('')
  const statisticsDate = useMemo(() => now ?? new Date(), [now])

  const productOptions = useMemo(
    () => listProductsForSalesStatistics(products, orders),
    [orders, products],
  )
  const effectiveSelection = useMemo(
    () => selectedProductIds ?? new Set(productOptions.map(({ id }) => id)),
    [productOptions, selectedProductIds],
  )
  const statistics = useMemo(
    () =>
      calculateProductSalesStatistics({
        orders,
        corrections,
        products,
        selectedProductIds: effectiveSelection,
        now: statisticsDate,
      }),
    [corrections, effectiveSelection, orders, products, statisticsDate],
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
        <aside>
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
            Ventes d’aujourd’hui
          </h3>
          <p className="mt-1 text-sm font-bold text-stone-600">
            Les annulations sont exclues et les remboursements par article sont déduits.
          </p>

          {effectiveSelection.size === 0 ? (
            <p className="mt-5 border border-stone-300 bg-stone-50 p-4 font-bold text-stone-700">
              Sélectionnez au moins un produit.
            </p>
          ) : (
            <>
              {!statistics.hasSales ? (
                <p className="mt-5 border border-stone-300 bg-stone-50 p-4 font-bold text-stone-700">
                  Aucune vente aujourd’hui.
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
                <table className="w-full min-w-[600px] border-collapse text-left">
                  <thead className="bg-stone-100">
                    <tr>
                      <ColumnHeader>Produit</ColumnHeader>
                      <ColumnHeader numeric>Quantité vendue</ColumnHeader>
                      <ColumnHeader numeric>Chiffre d’affaires</ColumnHeader>
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
                              {row.quantitySharePercent === null
                                ? '—'
                                : formatPercent(row.quantitySharePercent)}
                            </Cell>
                          </>
                        ) : (
                          <td className="px-3 py-3 text-right font-bold text-amber-900" colSpan={3}>
                            Indisponible — correction sans détail article
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
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
