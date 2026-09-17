import { describe, expect, it } from 'vitest'
import type { Product } from '../types/catalog'
import { assertCatalogReadyForProduction } from './catalog'

function createProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'produit-confirme',
    name: 'Produit confirmé',
    categoryId: 'assiettes',
    active: true,
    displayOrder: 0,
    requiresPreparation: true,
    availability: 'available',
    priceCents: 1_000,
    vatRate: 10,
    dataConfidence: 'confirmed',
    ...overrides,
  }
}

describe('validation du catalogue de production', () => {
  it('refuse un produit temporaire et affiche sa note', () => {
    const catalog = [
      createProduct({
        id: 'steak-hache',
        name: 'Steak haché',
        dataConfidence: 'temporary',
        note: 'Prix à confirmer.',
      }),
    ]

    expect(() => assertCatalogReadyForProduction(catalog)).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/Produit "Steak haché" \(steak-hache\).*Prix à confirmer\./),
      }),
    )
  })

  it('refuse une variante temporaire d’un produit confirmé', () => {
    const catalog = [
      createProduct({
        id: 'biere',
        name: 'Bière',
        priceCents: undefined,
        variants: [
          {
            id: '25cl',
            name: 'Demi',
            priceCents: 350,
            dataConfidence: 'confirmed',
          },
          {
            id: '50cl',
            name: 'Pinte',
            priceCents: 600,
            dataConfidence: 'temporary',
          },
        ],
      }),
    ]

    expect(() => assertCatalogReadyForProduction(catalog)).toThrowError(
      'Produit "Bière" (biere) > variante "Pinte" (50cl)',
    )
  })

  it('signale toutes les données temporaires dans l’ordre du catalogue', () => {
    const catalog = [
      createProduct({
        id: 'premier-produit',
        name: 'Premier produit',
        dataConfidence: 'temporary',
        variants: [
          {
            id: 'grande',
            name: 'Grande',
            priceCents: 1_200,
            dataConfidence: 'temporary',
          },
        ],
      }),
      createProduct({
        id: 'second-produit',
        name: 'Second produit',
        dataConfidence: 'temporary',
      }),
    ]

    let message = ''
    try {
      assertCatalogReadyForProduction(catalog)
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }

    expect(message).toContain('Produit "Premier produit" (premier-produit)')
    expect(message).toContain(
      'Produit "Premier produit" (premier-produit) > variante "Grande" (grande)',
    )
    expect(message).toContain('Produit "Second produit" (second-produit)')
    expect(message.indexOf('Premier produit')).toBeLessThan(message.indexOf('Second produit'))
  })

  it('accepte un catalogue confirmé ou sans marqueur de confiance', () => {
    const catalog = [
      createProduct(),
      createProduct({
        id: 'sans-marqueur',
        name: 'Sans marqueur',
        dataConfidence: undefined,
      }),
      createProduct({
        id: 'avec-variante',
        name: 'Avec variante',
        priceCents: undefined,
        variants: [{ id: 'standard', name: 'Standard', priceCents: 900 }],
      }),
    ]

    expect(() => assertCatalogReadyForProduction(catalog)).not.toThrow()
  })
})
