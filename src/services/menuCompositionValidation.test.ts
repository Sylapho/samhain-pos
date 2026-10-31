import { describe, expect, it } from 'vitest'
import { initialCatalogProducts } from '../data/initialCatalog'
import { initialCategories } from '../data/initialCategories'
import type { Product, ProductOptionGroup } from '../types/catalog'
import { createCartItemDraft, getDefaultProductSelection } from '../utils/cart'
import { validateProduct } from './productValidation'
import { validateCatalogContent } from './catalogDistribution'

const menu = initialCatalogProducts.find(({ id }) => id === 'menu-enfant')!

describe('composition du menu', () => {
  it('valide les choix par défaut et les suppléments sans modifier les identifiants', () => {
    const modified: Product = {
      ...menu,
      optionGroups: menu.optionGroups!.map((group) =>
        group.id === 'boisson'
          ? {
              ...group,
              options: [
                { ...group.options[0]!, default: false },
                { ...group.options[1]!, default: true, priceDeltaCents: 75 },
              ],
            }
          : group,
      ),
    }
    const validated = validateProduct(modified)
    expect(validated.optionGroups?.[1]?.id).toBe('boisson')
    expect(validated.optionGroups?.[1]?.options[1]?.id).toBe('jus-fruit')
    expect(getDefaultProductSelection(validated).optionIdsByGroup.boisson).toEqual(['jus-fruit'])
    expect(createCartItemDraft(validated).unitPriceCents).toBe(1025)
    expect(
      validateCatalogContent({ products: [validated], categories: initialCategories }, false)
        .products[0]?.optionGroups,
    ).toEqual(validated.optionGroups)
  })

  it('refuse les doublons, plusieurs défauts uniques et les suppléments non entiers', () => {
    const change = (update: Partial<ProductOptionGroup>) => ({
      ...menu,
      optionGroups: [{ ...menu.optionGroups![0]!, ...update }, ...menu.optionGroups!.slice(1)],
    })
    expect(() => validateProduct(change({ id: 'boisson' }))).toThrow('présent plusieurs fois')
    expect(() =>
      validateProduct(
        change({
          options: [menu.optionGroups![0]!.options[0]!, menu.optionGroups![0]!.options[0]!],
        }),
      ),
    ).toThrow('présent plusieurs fois')
    expect(() =>
      validateProduct(
        change({
          options: menu.optionGroups![0]!.options.map((option) => ({ ...option, default: true })),
        }),
      ),
    ).toThrow('choix par défaut')
    expect(() =>
      validateProduct(
        change({ options: [{ ...menu.optionGroups![0]!.options[0]!, priceDeltaCents: 1.5 }] }),
      ),
    ).toThrow('centimes')
    expect(() => validateProduct(change({ options: [] }))).toThrow('doit contenir un choix')
  })
})
