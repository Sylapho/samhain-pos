import type { Product } from '../../types/catalog'
import { ProductCard } from './ProductCard'

type ProductGridProps = {
  products: Product[]
  onSelect: (product: Product) => void
  lastAddedProductId: string | null
  status?: 'ready' | 'loading' | 'error'
  errorMessage?: string
}

export function ProductGrid({
  products,
  onSelect,
  lastAddedProductId,
  status = 'ready',
  errorMessage = 'Le catalogue ne peut pas être affiché.',
}: ProductGridProps) {
  if (status === 'loading') {
    return (
      <div
        className="border-y border-stone-300 py-10 text-center text-lg font-bold text-stone-600"
        role="status"
      >
        Chargement du catalogue…
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div
        className="border-y border-red-300 bg-red-50 py-10 text-center text-lg font-bold text-red-900"
        role="alert"
      >
        {errorMessage}
      </div>
    )
  }

  if (!products.length) {
    return (
      <div className="border-y border-stone-300 py-10 text-center text-lg font-bold text-stone-600">
        Aucun produit dans cette catégorie.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          onSelect={onSelect}
          recentlyAdded={lastAddedProductId === product.id}
        />
      ))}
    </div>
  )
}
