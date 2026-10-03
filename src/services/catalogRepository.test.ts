import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { initialCatalogProducts } from '../data/initialCatalog'
import { createCartItemDraft } from '../utils/cart'
import { CatalogService } from './catalogService'
import { IndexedDbCatalogRepository } from './catalogRepository'

function createService(indexedDb: IDBFactory, databaseName: string) {
  return new CatalogService(
    new IndexedDbCatalogRepository(indexedDb, databaseName),
    initialCatalogProducts,
  )
}

describe('catalogue persistant IndexedDB', () => {
  it('initialise une base vierge une seule fois sans écraser les modifications', async () => {
    const indexedDb = new IDBFactory()
    const databaseName = 'catalog-seed-once'
    const service = createService(indexedDb, databaseName)

    const seeded = await service.loadCatalog()
    expect(seeded).toHaveLength(initialCatalogProducts.length)
    const menu = seeded.find(({ id }) => id === 'menu-enfant')!
    await service.updateProduct({ ...menu, name: 'Menu enfant modifié' })

    const afterRestart = await createService(indexedDb, databaseName).loadCatalog()
    expect(afterRestart.find(({ id }) => id === menu.id)?.name).toBe('Menu enfant modifié')
    expect(afterRestart).toHaveLength(initialCatalogProducts.length)
  })

  it('lit, crée, modifie, désactive et réactive un produit hors connexion', async () => {
    const service = createService(new IDBFactory(), 'catalog-crud')
    await service.loadCatalog()
    const product = {
      ...structuredClone(initialCatalogProducts[0]!),
      id: 'nouveau-produit',
      name: 'Nouveau produit',
      displayOrder: 999,
      priceCents: 425,
      variants: undefined,
      optionGroups: undefined,
    }

    await service.createProduct(product)
    expect((await service.getProducts()).at(-1)).toMatchObject({
      id: 'nouveau-produit',
      priceCents: 425,
    })
    const modified = await service.updateProduct({ ...product, name: 'Produit renommé' })
    expect(modified.name).toBe('Produit renommé')
    expect((await service.setProductActive(modified, false)).active).toBe(false)
    expect((await service.setProductActive({ ...modified, active: false }, true)).active).toBe(true)
  })

  it('conserve variantes et options après persistance et rechargement', async () => {
    const indexedDb = new IDBFactory()
    const databaseName = 'catalog-complex-product'
    const service = createService(indexedDb, databaseName)
    const initial = await service.loadCatalog()
    const menu = initial.find(({ id }) => id === 'menu-enfant')!
    const beer = initial.find(({ id }) => id === 'biere-classique')!

    const restarted = createService(indexedDb, databaseName)
    const products = await restarted.loadCatalog()
    expect(products.find(({ id }) => id === menu.id)?.optionGroups).toEqual(menu.optionGroups)
    expect(products.find(({ id }) => id === beer.id)?.variants).toEqual(beer.variants)
  })

  it('retire les anciens ingrédients du burger sans réinitialiser le catalogue', async () => {
    const indexedDb = new IDBFactory()
    const databaseName = 'catalog-burger-composition-migration'
    const repository = new IndexedDbCatalogRepository(indexedDb, databaseName)
    const legacyCatalog = initialCatalogProducts.map((product) =>
      product.id === 'burger-samhain'
        ? {
            ...product,
            ingredients: [
              { id: 'cheddar', name: 'Cheddar' },
              { id: 'bacon', name: 'Bacon' },
            ],
          }
        : product,
    )
    await repository.initialize(legacyCatalog)
    const menu = (await repository.getProducts()).find(({ id }) => id === 'menu-enfant')!
    await repository.updateProduct({ ...menu, name: 'Menu enfant personnalisé' })

    const products = await createService(indexedDb, databaseName).loadCatalog()

    expect(products.find(({ id }) => id === 'burger-samhain')?.ingredients).toBeUndefined()
    expect(products.find(({ id }) => id === menu.id)?.name).toBe('Menu enfant personnalisé')
    expect(
      (await repository.getProducts()).find(({ id }) => id === 'burger-samhain')?.ingredients,
    ).toBeUndefined()
  })

  it('migre les anciens tarifs confirmés sans écraser un prix personnalisé', async () => {
    const indexedDb = new IDBFactory()
    const databaseName = 'catalog-confirmed-price-migration'
    const repository = new IndexedDbCatalogRepository(indexedDb, databaseName)
    const legacyCatalog = initialCatalogProducts.map((product) => {
      if (product.id === 'panini-bacon-cheddar') return { ...product, priceCents: 1_400 }
      if (product.id === 'steak-hache') return { ...product, priceCents: 1_350 }
      if (product.id !== 'biere-classique') return product
      return {
        ...product,
        variants: product.variants?.map((variant) => ({
          ...variant,
          priceCents: variant.id === '25cl' ? 350 : 600,
          dataConfidence: undefined,
        })),
      }
    })
    await repository.initialize(legacyCatalog)

    const migrated = await new CatalogService(repository, initialCatalogProducts).loadCatalog()

    expect(migrated.find(({ id }) => id === 'panini-bacon-cheddar')).toMatchObject({
      priceCents: 1_200,
      dataConfidence: 'confirmed',
    })
    expect(migrated.find(({ id }) => id === 'steak-hache')?.priceCents).toBe(1_350)
    expect(migrated.find(({ id }) => id === 'biere-classique')?.variants).toMatchObject([
      { id: '25cl', priceCents: 400, dataConfidence: 'confirmed' },
      { id: '50cl', priceCents: 750, dataConfidence: 'confirmed' },
    ])

    const afterRestart = await new CatalogService(repository, initialCatalogProducts).loadCatalog()
    expect(afterRestart).toEqual(migrated)
  })

  it('exclut les produits désactivés du jeu vendable sans supprimer leurs données', async () => {
    const service = createService(new IDBFactory(), 'catalog-disabled')
    const products = await service.loadCatalog()
    const product = products[0]!
    await service.setProductActive(product, false)

    const stored = await service.getProducts()
    expect(stored.find(({ id }) => id === product.id)?.active).toBe(false)
    expect(await service.getSellableProducts()).not.toContainEqual(
      expect.objectContaining({ id: product.id }),
    )
  })

  it('ne modifie jamais le snapshot d’une vente après modification du catalogue', async () => {
    const service = createService(new IDBFactory(), 'catalog-order-snapshot')
    const products = await service.loadCatalog()
    const beer = products.find(({ id }) => id === 'biere-classique')!
    const lineSnapshot = createCartItemDraft(beer, {
      variantId: '25cl',
      optionIdsByGroup: {},
    })

    await service.updateProduct({
      ...beer,
      name: 'Bière renommée',
      variants: beer.variants?.map((variant) => ({ ...variant, priceCents: 999 })),
      vatRate: 10,
    })

    expect(lineSnapshot).toMatchObject({
      name: 'Bière classique',
      unitPriceCents: 400,
      vatRate: 20,
      variant: { id: '25cl', name: 'Demi', volume: '25 cl' },
    })
  })
})
