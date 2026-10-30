import { describe, expect, it } from 'vitest'
import { witchesCatalogProducts } from './witchesCatalog'
import { witchesCategories } from './witchesCategories'

describe('catalogue initial Samhain Witches', () => {
  it('reprend la grille tarifaire fournie et le taux provisoire de 20 %', () => {
    expect(witchesCatalogProducts).toHaveLength(21)
    expect(witchesCategories.map(({ label }) => label)).toEqual([
      'Potions',
      'Gourmandises',
      'Le petit marché',
    ])
    expect(
      Object.fromEntries(witchesCatalogProducts.map(({ id, priceCents }) => [id, priceCents])),
    ).toEqual({
      'cafe-lune-noire': 200,
      'chocolat-chaud-magique': 300,
      'eau-minerale-songes': 200,
      'jus-de-fruits': 300,
      'the-chaudron-brumes': 300,
      'the-fees-volva': 300,
      'the-habondia': 300,
      'matcha-lait-vegetal': 450,
      'soupe-chaudron-sorcieres': 300,
      'pain-epices': 300,
      'carre-chocolat': 300,
      'roule-cannelle': 300,
      'cookie-ensorcele': 300,
      'sachet-bonbons': 300,
      'tee-shirt-samhain-2026': 2200,
      'sweat-pull-samhain-2026': 4500,
      'batons-lumineux': undefined,
      'ecocup-samhain': 200,
      'top-bag-samhain': 500,
      'livre-enigme-samhain': 1490,
      'ecusson-charme-samhain': 500,
    })
    expect(
      witchesCatalogProducts.every(
        (product) =>
          product.vatRate === 20 &&
          product.requiresPreparation &&
          product.dataConfidence === 'confirmed',
      ),
    ).toBe(true)
  })

  it('propose les choix de café et matcha ainsi que le lot de trois bâtons lumineux', () => {
    const product = (id: string) => witchesCatalogProducts.find((item) => item.id === id)
    expect(product('cafe-lune-noire')?.optionGroups?.[0]?.options.map(({ name }) => name)).toEqual([
      'Court',
      'Long',
    ])
    expect(product('matcha-lait-vegetal')?.optionGroups?.map(({ name }) => name)).toEqual([
      'Lait végétal',
      'Sirop',
    ])
    expect(product('batons-lumineux')?.variants?.map(({ priceCents }) => priceCents)).toEqual([
      300, 700,
    ])
  })
})
