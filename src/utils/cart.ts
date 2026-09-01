import type { CartItemDraft } from '../types/cart'
import type { Product, ProductSelection } from '../types/catalog'

export function getProductStartingPriceCents(product: Product): number {
  if (product.variants?.length) {
    return Math.min(...product.variants.map((variant) => variant.priceCents))
  }
  if (product.priceCents === undefined) {
    throw new Error(`Aucun prix défini pour ${product.name}`)
  }
  return product.priceCents
}

export function requiresProductConfiguration(product: Product): boolean {
  return Boolean((product.variants?.length ?? 0) > 1 || product.optionGroups?.length)
}

export function getDefaultProductSelection(product: Product): ProductSelection {
  return {
    variantId: product.variants?.[0]?.id,
    optionIds: Object.fromEntries(
      (product.optionGroups ?? []).map((group) => [group.id, group.options[0]?.id ?? '']),
    ),
  }
}

export function createCartItemDraft(
  product: Product,
  selection: ProductSelection = { optionIds: {} },
): CartItemDraft {
  const variant =
    product.variants?.find((candidate) => candidate.id === selection.variantId) ??
    (product.variants?.length === 1 ? product.variants[0] : undefined)

  if (product.variants?.length && !variant) {
    throw new Error(`Une variante est requise pour ${product.name}`)
  }

  const options = (product.optionGroups ?? []).flatMap((group) => {
    const selectedId = selection.optionIds[group.id]
    const option = group.options.find((candidate) => candidate.id === selectedId)
    if (!option && group.required) {
      throw new Error(`Le choix « ${group.name} » est requis pour ${product.name}`)
    }
    return option
      ? [
          {
            groupId: group.id,
            groupName: group.name,
            optionId: option.id,
            optionName: option.name,
            priceDeltaCents: option.priceDeltaCents ?? 0,
          },
        ]
      : []
  })

  const basePriceCents = variant?.priceCents ?? product.priceCents
  if (basePriceCents === undefined) {
    throw new Error(`Aucun prix défini pour ${product.name}`)
  }

  const hasTemporaryData =
    product.dataConfidence === 'temporary' || variant?.dataConfidence === 'temporary'

  return {
    productId: product.id,
    name: product.name,
    unitPriceCents:
      basePriceCents + options.reduce((sum, option) => sum + option.priceDeltaCents, 0),
    variant: variant ? { id: variant.id, name: variant.name, volume: variant.volume } : undefined,
    options,
    dataConfidence: hasTemporaryData ? 'temporary' : 'confirmed',
    note: variant?.note ?? product.note,
  }
}
