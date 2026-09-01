import type { Product } from '../../types/catalog'
import { ProductCard } from './ProductCard'

type ProductGridProps = {
  products: Product[]
  onSelect: (product: Product) => void
}

export function ProductGrid({ products, onSelect }: ProductGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} onSelect={onSelect} />
      ))}
    </div>
  )
}
