import type { Product } from '../types/catalog.ts'

function formatNote(note: string | undefined): string {
  return note ? ` — Note : ${note}` : ''
}

export function assertCatalogReadyForProduction(catalog: readonly Product[]): void {
  const temporaryEntries: string[] = []

  for (const product of catalog) {
    if (product.dataConfidence === 'temporary') {
      temporaryEntries.push(`Produit "${product.name}" (${product.id})${formatNote(product.note)}`)
    }

    for (const variant of product.variants ?? []) {
      if (variant.dataConfidence === 'temporary') {
        temporaryEntries.push(
          `Produit "${product.name}" (${product.id}) > variante "${variant.name}" (${variant.id})${formatNote(variant.note)}`,
        )
      }
    }
  }

  if (temporaryEntries.length > 0) {
    throw new Error(
      `Catalogue de production invalide : des données commerciales temporaires doivent être confirmées :\n${temporaryEntries.map((entry) => `- ${entry}`).join('\n')}`,
    )
  }
}
