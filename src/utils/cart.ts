import type { CartItem, CartItemDraft } from '../types/cart'
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
    optionIdsByGroup: Object.fromEntries(
      (product.optionGroups ?? []).map((group) => {
        const defaultIds = group.options
          .filter((option) => option.default)
          .map((option) => option.id)
        return [group.id, group.type === 'single' ? defaultIds.slice(0, 1) : defaultIds]
      }),
    ),
  }
}

export function createCartItemDraft(
  product: Product,
  selection: ProductSelection = getDefaultProductSelection(product),
  removedIngredientIds: string[] = [],
): CartItemDraft {
  const variant =
    product.variants?.find((candidate) => candidate.id === selection.variantId) ??
    (product.variants?.length === 1 ? product.variants[0] : undefined)

  if (product.variants?.length && !variant) {
    throw new Error(`Une variante est requise pour ${product.name}`)
  }

  const options = (product.optionGroups ?? []).flatMap((group) => {
    const selectedIds = [...new Set(selection.optionIdsByGroup[group.id] ?? [])]
    if (group.type === 'single' && selectedIds.length > 1) {
      throw new Error(`Un seul choix est autorisé pour « ${group.name} »`)
    }
    const unknownId = selectedIds.find(
      (selectedId) => !group.options.some((option) => option.id === selectedId),
    )
    if (unknownId) {
      throw new Error(`Option inconnue dans « ${group.name} » : ${unknownId}`)
    }
    if (!selectedIds.length && group.required) {
      throw new Error(`Le choix « ${group.name} » est requis pour ${product.name}`)
    }
    const selectedIdSet = new Set(selectedIds)
    return group.options
      .filter((option) => selectedIdSet.has(option.id))
      .map((option) => ({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        priceDeltaCents: option.priceDeltaCents ?? 0,
      }))
  })

  const basePriceCents = variant?.priceCents ?? product.priceCents
  if (basePriceCents === undefined) {
    throw new Error(`Aucun prix défini pour ${product.name}`)
  }

  const hasTemporaryData =
    product.dataConfidence === 'temporary' || variant?.dataConfidence === 'temporary'

  const availableIngredientIds = new Set(
    (product.ingredients ?? []).map((ingredient) => ingredient.id),
  )
  const normalizedRemovedIngredientIds = [...new Set(removedIngredientIds)]
    .filter((ingredientId) => availableIngredientIds.has(ingredientId))
    .sort()

  return {
    productId: product.id,
    name: product.name,
    unitPriceCents:
      basePriceCents + options.reduce((sum, option) => sum + option.priceDeltaCents, 0),
    variant: variant ? { id: variant.id, name: variant.name, volume: variant.volume } : undefined,
    options,
    ingredients: (product.ingredients ?? []).map((ingredient) => ({ ...ingredient })),
    removedIngredientIds: normalizedRemovedIngredientIds,
    dataConfidence: hasTemporaryData ? 'temporary' : 'confirmed',
    note: variant?.note ?? product.note,
    vatRate: product.vatRate,
  }
}

export function getCartItemProductSelection(item: CartItem): ProductSelection {
  const optionIdsByGroup: Record<string, string[]> = {}
  for (const option of item.options) {
    optionIdsByGroup[option.groupId] = [
      ...(optionIdsByGroup[option.groupId] ?? []),
      option.optionId,
    ]
  }
  return { variantId: item.variant?.id, optionIdsByGroup }
}

export function getRemovedIngredients(
  item: Pick<CartItemDraft, 'ingredients' | 'removedIngredientIds'>,
) {
  const removedIds = new Set(item.removedIngredientIds)
  return item.ingredients.filter((ingredient) => removedIds.has(ingredient.id))
}
