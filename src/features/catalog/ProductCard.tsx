import type { Product } from '../../types/catalog'
import { getProductStartingPriceCents, requiresProductConfiguration } from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type ProductCardProps = {
  product: Product
  onSelect: (product: Product) => void
  recentlyAdded: boolean
}

export function ProductCard({ product, onSelect, recentlyAdded }: ProductCardProps) {
  const soldOut = product.availability === 'sold-out'
  const needsConfiguration = requiresProductConfiguration(product)
  const startingPrice = getProductStartingPriceCents(product)
  const hasTemporaryData =
    product.dataConfidence === 'temporary' ||
    product.variants?.some((variant) => variant.dataConfidence === 'temporary')

  return (
    <button
      type="button"
      disabled={soldOut}
      onClick={() => onSelect(product)}
      aria-label={`${product.name}, ${product.variants?.length ? 'à partir de ' : ''}${formatMoney(startingPrice)}${needsConfiguration ? ', choix requis' : ''}${soldOut ? ', épuisé' : ''}`}
      className={`product-card relative flex min-h-36 w-full flex-col items-start justify-between rounded-[10px] border-2 p-4 text-left transition-[border-color,background-color,transform] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${
        soldOut
          ? 'cursor-not-allowed border-stone-300 bg-stone-100 text-stone-500'
          : recentlyAdded
            ? 'product-card-added border-[#1f6a4b] bg-[#f0f8f3] text-stone-950'
            : 'border-stone-300 bg-[#fffdf8] text-stone-950 active:scale-[0.985] active:bg-stone-100'
      }`}
    >
      <div className="w-full">
        <div className="text-lg font-black leading-tight">{product.name}</div>
        {product.description ? (
          <div className="mt-2 text-sm font-medium leading-snug text-stone-600">
            {product.description}
          </div>
        ) : null}
        {recentlyAdded ? (
          <div className="mt-2 text-sm font-extrabold text-[#185b40]" role="status">
            Ajouté à la commande
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex w-full items-end justify-between gap-3">
        <span className="text-xl font-black tabular-nums">
          {product.variants?.length ? (
            <span className="mr-1 text-xs font-bold text-stone-500">Dès</span>
          ) : null}
          {formatMoney(startingPrice)}
        </span>
        {needsConfiguration ? (
          <span className="text-sm font-extrabold text-[#234f3c]">Choisir</span>
        ) : hasTemporaryData ? (
          <span className="text-xs font-bold text-amber-800">À confirmer</span>
        ) : null}
      </div>
      {hasTemporaryData && needsConfiguration ? (
        <div className="mt-2 text-xs font-bold text-amber-800">Une donnée reste à confirmer</div>
      ) : null}
    </button>
  )
}
