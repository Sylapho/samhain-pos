import type { Product, ProductVariant } from '../types/catalog'

type PriceChange = {
  from: number
  to: number
}

const productPriceChanges: Readonly<Record<string, PriceChange>> = {
  'panini-bacon-cheddar': { from: 1_400, to: 1_200 },
  'steak-hache': { from: 1_200, to: 1_400 },
  'chipolata-x2': { from: 1_200, to: 1_400 },
  'merguez-x2': { from: 1_200, to: 1_400 },
  'crepe-chocolat': { from: 250, to: 300 },
  cafe: { from: 150, to: 200 },
  eau: { from: 300, to: 150 },
  'cola-temporaire': { from: 250, to: 300 },
  oasis: { from: 250, to: 300 },
}

const variantPriceChanges: Readonly<Record<string, Readonly<Record<string, PriceChange>>>> = {
  'biere-classique': {
    '25cl': { from: 350, to: 400 },
    '50cl': { from: 600, to: 750 },
  },
  'biere-prestige': {
    '25cl': { from: 450, to: 500 },
    '50cl': { from: 800, to: 900 },
  },
  'cidre-fermier': {
    '25cl': { from: 300, to: 250 },
    '50cl': { from: 500, to: 450 },
  },
}

function migrateVariant(variant: ProductVariant, change: PriceChange | undefined): ProductVariant {
  if (!change || ![change.from, change.to].includes(variant.priceCents)) return variant
  if (variant.priceCents === change.to && variant.dataConfidence === 'confirmed') return variant
  return { ...variant, priceCents: change.to, dataConfidence: 'confirmed' }
}

export function migrateConfirmedCatalogPrices(product: Product): Product {
  const productChange = productPriceChanges[product.id]
  const canMigrateProductPrice =
    productChange !== undefined &&
    product.priceCents !== undefined &&
    [productChange.from, productChange.to].includes(product.priceCents)
  const migratedVariants = product.variants?.map((variant) =>
    migrateVariant(variant, variantPriceChanges[product.id]?.[variant.id]),
  )
  const variantsChanged = migratedVariants?.some(
    (variant, index) => variant !== product.variants?.[index],
  )

  if (!canMigrateProductPrice && !variantsChanged) return product
  return {
    ...product,
    ...(canMigrateProductPrice
      ? { priceCents: productChange.to, dataConfidence: 'confirmed' as const }
      : {}),
    ...(variantsChanged ? { variants: migratedVariants } : {}),
  }
}
