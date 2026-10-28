import { useMemo, useState } from 'react'
import { ProductStatisticsSelector } from './ProductStatisticsSelector'
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
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3 sm:p-4"
      aria-label="Statistiques des produits"
    >
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-labelledby="product-statistics-title"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <ProductStatisticsSelector
            products={productOptions}
            selection={effectiveSelection}
            onToggle={toggleProduct}
            onSelectAll={() => setSelectedProductIds(new Set(productOptions.map(({ id }) => id)))}
            onClear={() => setSelectedProductIds(new Set())}
          />
          <h3 id="product-statistics-title" className="text-2xl font-black">
            Ventes d’aujourd’hui
          </h3>
        </div>
        <div
          className="mt-3 min-h-0 flex-1 overflow-auto overscroll-contain border-y border-stone-300"
          role="region"
          aria-label="Ventes par produit"
          tabIndex={0}
        >
          <p className="mt-1 shrink-0 text-sm font-bold text-stone-600">
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

              <table className="w-full min-w-[520px] table-fixed border-collapse text-left">
                <thead className="sticky top-0 bg-stone-100">
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
                      <th className="break-words px-3 py-3 font-black" scope="row">
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
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function ColumnHeader({ children, numeric = false }: { children: string; numeric?: boolean }) {
  return (
    <th className={`px-3 py-3 font-black ${numeric ? 'w-[22%] text-right' : ''}`} scope="col">
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
