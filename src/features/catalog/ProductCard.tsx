import type { Product } from '../../types/catalog'
import { formatMoney } from '../../utils/money'

type ProductCardProps = {
  product: Product
  onSelect: (product: Product) => void
}

export function ProductCard({ product, onSelect }: ProductCardProps) {
  const soldOut = product.availability === 'sold-out'

  return (
    <button
      type="button"
      disabled={soldOut}
      onClick={() => onSelect(product)}
      aria-label={`${product.name}, ${formatMoney(product.priceCents)}${soldOut ? ', épuisé' : ''}`}
      className={`relative flex min-h-32 w-full flex-col items-start justify-between rounded-2xl border p-4 text-left shadow-sm transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
        soldOut
          ? 'cursor-not-allowed border-slate-300 bg-slate-100 text-slate-500'
          : 'border-slate-200 bg-white text-slate-950 hover:border-slate-400 hover:shadow-md active:scale-[0.985] active:bg-slate-50'
      }`}
    >
      <div>
        <div className="text-lg font-black leading-tight">{product.name}</div>
        {product.hasOptionsPrototype && !soldOut ? (
          <div className="mt-2 inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">
            Choix requis
          </div>
        ) : null}
        {soldOut ? (
          <div className="mt-3 rounded-lg border border-slate-400 bg-white px-2 py-1 text-sm font-black uppercase tracking-wide text-slate-800">
            Épuisé
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex w-full items-end justify-between gap-2">
        <span className="text-xl font-black tabular-nums">{formatMoney(product.priceCents)}</span>
        {product.priceIsMock ? (
          <span className="text-xs font-bold text-amber-800">Prix fictif</span>
        ) : null}
      </div>
    </button>
  )
}
