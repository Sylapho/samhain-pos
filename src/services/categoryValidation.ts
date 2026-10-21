import type { Category, Product } from '../types/catalog.ts'

export function normalizeCategoryLabel(label: string): string {
  return label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ')
}

export function sortCategories(categories: readonly Category[]): Category[] {
  return [...categories].sort(
    (a, b) => a.displayOrder - b.displayOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export function validateCategory(category: Category, existing: readonly Category[]): Category {
  const label = category.label.trim().replace(/\s+/g, ' ')
  if (!label) throw new Error('Le nom de la catégorie est requis.')
  if (!category.id.trim()) throw new Error('L’identifiant de la catégorie est requis.')
  if (!Number.isSafeInteger(category.displayOrder) || category.displayOrder < 0)
    throw new Error('L’ordre d’affichage doit être un entier positif.')
  if (typeof category.active !== 'boolean')
    throw new Error('Le statut de la catégorie est invalide.')
  if (
    existing.some(
      (other) =>
        other.id !== category.id &&
        normalizeCategoryLabel(other.label) === normalizeCategoryLabel(label),
    )
  )
    throw new Error('Une catégorie porte déjà ce nom.')
  return { ...category, label }
}

export function validateProductCategory(
  product: Product,
  categories: readonly Category[],
  previous?: Product,
): void {
  const category = categories.find(({ id }) => id === product.categoryId)
  if (!category) throw new Error('La catégorie n’existe pas.')
  if (!category.active && previous?.categoryId !== product.categoryId)
    throw new Error('Choisissez une catégorie active pour cette affectation.')
}

export function reorderedCategories(
  categories: readonly Category[],
  ids: readonly string[],
): Category[] {
  if (
    ids.length !== categories.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !categories.some((category) => category.id === id))
  )
    throw new Error('La liste des catégories a changé. Rechargez-la avant de réorganiser.')
  return ids.map((id, displayOrder) => ({
    ...categories.find((category) => category.id === id)!,
    displayOrder,
  }))
}
