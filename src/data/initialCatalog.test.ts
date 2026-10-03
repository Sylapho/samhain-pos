import { describe, expect, it } from 'vitest'
import { initialCatalogProducts } from './initialCatalog'
import { potionBarCatalogProducts } from './potionBarCatalog'

function productPrice(productId: string): number | undefined {
  return initialCatalogProducts.find(({ id }) => id === productId)?.priceCents
}

function variantPrice(productId: string, variantId: string): number | undefined {
  return initialCatalogProducts
    .find(({ id }) => id === productId)
    ?.variants?.find(({ id }) => id === variantId)?.priceCents
}

describe('tarifs confirmés du catalogue initial', () => {
  it('reprend les tarifs unitaires de la carte', () => {
    expect({
      menuEnfant: productPrice('menu-enfant'),
      omelette: productPrice('omelette'),
      paniniBaconCheddar: productPrice('panini-bacon-cheddar'),
      steakHache: productPrice('steak-hache'),
      chipolataX2: productPrice('chipolata-x2'),
      merguezX2: productPrice('merguez-x2'),
      burgerSamhain: productPrice('burger-samhain'),
      crepeChocolat: productPrice('crepe-chocolat'),
      crepeSucre: productPrice('crepe-sucre'),
      crepeCaramel: productPrice('crepe-caramel'),
      cafe: productPrice('cafe'),
      the: productPrice('the'),
      chocolatChaud: productPrice('chocolat-chaud'),
      vinChaud: productPrice('vin-chaud'),
      eau: productPrice('eau'),
      cocaCola: productPrice('cola-temporaire'),
      oasis: productPrice('oasis'),
    }).toEqual({
      menuEnfant: 950,
      omelette: 1_000,
      paniniBaconCheddar: 1_200,
      steakHache: 1_400,
      chipolataX2: 1_400,
      merguezX2: 1_400,
      burgerSamhain: 1_600,
      crepeChocolat: 300,
      crepeSucre: 200,
      crepeCaramel: 250,
      cafe: 200,
      the: 200,
      chocolatChaud: 250,
      vinChaud: 300,
      eau: 150,
      cocaCola: 300,
      oasis: 300,
    })
  })

  it('reprend les tarifs des formats de bière et de cidre', () => {
    expect({
      biereClassique25cl: variantPrice('biere-classique', '25cl'),
      biereClassique50cl: variantPrice('biere-classique', '50cl'),
      bierePrestige25cl: variantPrice('biere-prestige', '25cl'),
      bierePrestige50cl: variantPrice('biere-prestige', '50cl'),
      cidreFermier25cl: variantPrice('cidre-fermier', '25cl'),
      cidreFermier50cl: variantPrice('cidre-fermier', '50cl'),
    }).toEqual({
      biereClassique25cl: 400,
      biereClassique50cl: 750,
      bierePrestige25cl: 500,
      bierePrestige50cl: 900,
      cidreFermier25cl: 250,
      cidreFermier50cl: 450,
    })
  })
})

describe('catalogue Witches Potion Bar', () => {
  it('reprend les prix et les taux de TVA fournis', () => {
    expect(
      Object.fromEntries(
        potionBarCatalogProducts.map(({ id, priceCents, variants, vatRate }) => [
          id,
          { priceCents, variantPrices: variants?.map((variant) => variant.priceCents), vatRate },
        ]),
      ),
    ).toEqual({
      'potion-bar-cafe-lune-noire': { priceCents: 200, variantPrices: undefined, vatRate: 10 },
      'potion-bar-chocolat-chaud-magique': {
        priceCents: 300,
        variantPrices: undefined,
        vatRate: 10,
      },
      'potion-bar-eau-minerale-songes': {
        priceCents: 200,
        variantPrices: undefined,
        vatRate: 10,
      },
      'potion-bar-jus-fruits': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-the-samhain': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-the-fees-wolwa': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-the-habondia': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-matcha-lait-vegetal': {
        priceCents: 450,
        variantPrices: undefined,
        vatRate: 10,
      },
      'potion-bar-soupe-chaudron': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-pain-epices': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-carre-chocolat': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-roule-cannelle': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-cookie-ensorcele': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-sachet-bonbons': { priceCents: 300, variantPrices: undefined, vatRate: 10 },
      'potion-bar-tee-shirt': { priceCents: 2200, variantPrices: undefined, vatRate: 20 },
      'potion-bar-sweat-pull': { priceCents: 4500, variantPrices: undefined, vatRate: 20 },
      'potion-bar-batons-lumineux': {
        priceCents: undefined,
        variantPrices: [300, 700],
        vatRate: 20,
      },
      'potion-bar-ecocup': { priceCents: 200, variantPrices: undefined, vatRate: 20 },
      'potion-bar-top-bag': { priceCents: 500, variantPrices: undefined, vatRate: 20 },
      'potion-bar-livre-enigme': { priceCents: 1490, variantPrices: undefined, vatRate: 20 },
      'potion-bar-ecusson-charme': { priceCents: 500, variantPrices: undefined, vatRate: 20 },
    })
  })

  it('envoie les consommables en préparation mais pas les produits du petit marché', () => {
    expect(
      potionBarCatalogProducts.every((product) =>
        product.categoryId === 'marche-sorciere'
          ? !product.requiresPreparation
          : product.requiresPreparation,
      ),
    ).toBe(true)
  })
})
