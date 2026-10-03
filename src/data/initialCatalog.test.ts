import { describe, expect, it } from 'vitest'
import { initialCatalogProducts } from './initialCatalog'

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
