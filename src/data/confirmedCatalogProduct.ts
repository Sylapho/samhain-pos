import type { Product } from '../types/catalog.ts'

// Used only for the approved seed and the one-time local catalogue migration.
export function confirmedCatalogProduct(product: Product): Product {
  return {
    ...product,
    dataConfidence: 'confirmed',
    ...(product.variants
      ? {
          variants: product.variants.map((variant) => ({
            ...variant,
            dataConfidence: 'confirmed',
          })),
        }
      : {}),
  }
}
