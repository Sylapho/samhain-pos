import type { Product, ProductOptionGroup, ProductVariant } from './catalog.ts'

function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} est requis.`)
  return normalized
}

function requireId(value: string, label: string): string {
  return requireText(value, label)
}

function validatePrice(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} doit être un montant positif exprimé en centimes.`)
  }
  return value
}

function validateVariants(variants: ProductVariant[] | undefined): ProductVariant[] | undefined {
  if (!variants?.length) return undefined
  const ids = new Set<string>()
  return variants.map((variant) => {
    const id = requireId(variant.id, 'L’identifiant de variante')
    if (ids.has(id)) throw new Error(`La variante « ${id} » est présente plusieurs fois.`)
    ids.add(id)
    return {
      ...variant,
      id,
      name: requireText(variant.name, 'Le nom de variante'),
      ...(variant.volume?.trim() ? { volume: variant.volume.trim() } : { volume: undefined }),
      priceCents: validatePrice(variant.priceCents, `Le prix de « ${variant.name} »`),
    }
  })
}

function validateOptionGroups(
  groups: ProductOptionGroup[] | undefined,
): ProductOptionGroup[] | undefined {
  if (!groups?.length) return undefined
  const groupIds = new Set<string>()
  return groups.map((group) => {
    const id = requireId(group.id, 'L’identifiant du groupe de choix')
    if (groupIds.has(id)) throw new Error(`Le groupe « ${id} » est présent plusieurs fois.`)
    groupIds.add(id)
    if (!group.options.length)
      throw new Error(`Le groupe « ${group.name} » doit contenir un choix.`)
    const optionIds = new Set<string>()
    const options = group.options.map((option) => {
      const optionId = requireId(option.id, 'L’identifiant du choix')
      if (optionIds.has(optionId)) {
        throw new Error(
          `Le choix « ${optionId} » est présent plusieurs fois dans « ${group.name} ».`,
        )
      }
      optionIds.add(optionId)
      return {
        ...option,
        id: optionId,
        name: requireText(option.name, 'Le nom du choix'),
        priceDeltaCents: validatePrice(option.priceDeltaCents ?? 0, 'Le supplément'),
      }
    })
    return { ...group, id, name: requireText(group.name, 'Le nom du groupe de choix'), options }
  })
}

export function validateProduct(product: Product): Product {
  requireId(product.categoryId, 'La catégorie')
  if (![10, 20].includes(product.vatRate)) throw new Error('Le taux de TVA est invalide.')
  if (!Number.isSafeInteger(product.displayOrder) || product.displayOrder < 0) {
    throw new Error('L’ordre d’affichage doit être un entier positif.')
  }
  const variants = validateVariants(product.variants)
  if (!variants?.length && product.priceCents === undefined) {
    throw new Error('Un prix ou au moins une variante est requis.')
  }
  const ingredients = product.ingredients?.map((ingredient) => ({
    id: requireId(ingredient.id, 'L’identifiant d’ingrédient'),
    name: requireText(ingredient.name, 'Le nom d’ingrédient'),
  }))
  if (ingredients && new Set(ingredients.map(({ id }) => id)).size !== ingredients.length) {
    throw new Error('Un ingrédient est présent plusieurs fois.')
  }
  return {
    ...structuredClone(product),
    id: requireId(product.id, 'L’identifiant du produit'),
    name: requireText(product.name, 'Le nom'),
    description: product.description?.trim() || undefined,
    priceCents:
      product.priceCents === undefined ? undefined : validatePrice(product.priceCents, 'Le prix'),
    variants,
    optionGroups: validateOptionGroups(product.optionGroups),
    ingredients: ingredients?.length ? ingredients : undefined,
  }
}
