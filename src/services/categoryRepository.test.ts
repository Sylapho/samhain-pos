import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { witchesCategories } from '../data/witchesCategories'
import { witchesCatalogProducts } from '../data/witchesCatalog'
import { CatalogService } from './catalogService'
import { IndexedDbCatalogRepository } from './catalogRepository'
import { openSamhainDatabase } from './indexedDbSchema'

async function setup(factory = new IDBFactory(), name = 'categories') {
  const repository = new IndexedDbCatalogRepository(factory, name)
  const service = new CatalogService(repository)
  await service.loadCatalog()
  return { repository, service, factory, name }
}

describe('catégories persistantes et validation transactionnelle', () => {
  it('crée, renomme, désactive, réactive et réordonne avec ID stable après redémarrage', async () => {
    const { service, factory, name } = await setup()
    const created = await service.createCategory('  Nouveautés  du jour ')
    expect(created).toMatchObject({ label: 'Nouveautés du jour', active: true, displayOrder: 3 })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    await service.updateCategory(created.id, 'Spécialités')
    await service.setCategoryActive(created.id, false)
    expect(await service.getActiveCategories()).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    )
    const ids = (await service.getCategories()).map(({ id }) => id).reverse()
    await service.reorderCategories(ids)
    const restarted = new CatalogService(new IndexedDbCatalogRepository(factory, name))
    await restarted.loadCatalog()
    expect(await restarted.getCategories()).toEqual(await service.getCategories())
    expect((await restarted.getCategories())[0]).toEqual({
      id: created.id,
      label: 'Spécialités',
      active: false,
      displayOrder: 0,
    })
    expect((await restarted.setCategoryActive(created.id, true)).id).toBe(created.id)
    expect((await restarted.getActiveCategories())[0]?.id).toBe(created.id)
    expect((await restarted.getCategories()).map(({ id }) => id)).toEqual(ids)
  })

  it('refuse noms vides et doublons même avec accents, espaces, casse ou catégorie inactive', async () => {
    const { service } = await setup()
    await expect(service.createCategory(' \t ')).rejects.toThrow('nom')
    await expect(service.createCategory('  POTIONS ')).rejects.toThrow('déjà')
    await service.setCategoryActive('potions', false)
    await expect(service.updateCategory('gourmandises', 'potions')).rejects.toThrow('déjà')
    await expect(service.updateCategory('gourmandises', '  ')).rejects.toThrow('nom')
    expect((await service.getCategories()).find(({ id }) => id === 'gourmandises')?.label).toBe(
      'Gourmandises',
    )
  })

  it('vérifie les références et garde les produits associés aux catégories inactives', async () => {
    const { service } = await setup()
    const newCategory = await service.createCategory('Nouvelle catégorie')
    const product = { ...witchesCatalogProducts[0]!, id: 'new', categoryId: newCategory.id }
    await service.createProduct(product)
    await service.setCategoryActive(newCategory.id, false)
    await expect(service.updateProduct({ ...product, name: 'Renommé' })).resolves.toMatchObject({
      categoryId: newCategory.id,
    })
    await expect(service.createProduct({ ...product, id: 'inactive' })).rejects.toThrow('active')
    await expect(
      service.createProduct({ ...product, id: 'unknown', categoryId: 'absente' }),
    ).rejects.toThrow('n’existe pas')
    const other = (await service.getProducts()).find(({ id }) => id !== 'new')!
    await expect(service.updateProduct({ ...other, categoryId: newCategory.id })).rejects.toThrow(
      'active',
    )
    await expect(service.updateProduct({ ...product, categoryId: 'absente' })).rejects.toThrow(
      'n’existe pas',
    )
    await service.updateProduct({ ...product, categoryId: 'gourmandises' })
    expect(await service.getProducts()).toHaveLength(witchesCatalogProducts.length + 1)
  })

  it('sérialise créations concurrentes et désactivation contre une affectation', async () => {
    const { service, factory, name } = await setup()
    const second = new CatalogService(new IndexedDbCatalogRepository(factory, name))
    const result = await Promise.allSettled([
      service.createCategory('Concurrente'),
      second.createCategory(' CONCURRENTE '),
    ])
    expect(result.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const category = (await service.getCategories()).find(({ label }) => label === 'Concurrente')!
    const inactive = service.setCategoryActive(category.id, false)
    const create = second.createProduct({
      ...witchesCatalogProducts[0]!,
      id: 'race',
      categoryId: category.id,
    })
    await inactive
    await expect(create).rejects.toThrow('active')
    expect(await service.getProducts()).not.toContainEqual(expect.objectContaining({ id: 'race' }))
  })

  it('refuse un réordonnancement incomplet, dupliqué ou obsolète sans écriture', async () => {
    const { service } = await setup()
    const before = await service.getCategories()
    await expect(service.reorderCategories(['potions'])).rejects.toThrow('changé')
    await expect(service.reorderCategories(before.map(() => 'potions'))).rejects.toThrow('changé')
    const stale = before.map(({ id }) => id)
    await service.createCategory('Ajoutée entre-temps')
    await expect(service.reorderCategories(stale)).rejects.toThrow('changé')
    expect((await service.getCategories()).slice(0, 3)).toEqual(before)
  })

  it('annule toutes les positions si une écriture échoue après le premier changement', async () => {
    const { service } = await setup()
    const before = await service.getCategories()
    const original = IDBObjectStore.prototype.put
    let writes = 0
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'categories' && ++writes === 2) throw new Error('Échec simulé')
      return original.apply(this, args)
    })
    try {
      await expect(service.reorderCategories(before.map(({ id }) => id).reverse())).rejects.toThrow(
        'Échec simulé',
      )
    } finally {
      spy.mockRestore()
    }
    expect(await service.getCategories()).toEqual(before)
  })

  it('annule produits, catégories et marqueur ensemble puis permet de recommencer', async () => {
    const repository = new IndexedDbCatalogRepository(new IDBFactory(), 'abort-seed')
    await expect(
      repository.initialize([witchesCatalogProducts[0]!, witchesCatalogProducts[0]!]),
    ).rejects.toThrow()
    expect(await repository.getProducts()).toEqual([])
    expect(await repository.getCategories()).toEqual([])
    expect((await repository.initialize(witchesCatalogProducts)).initialized).toBe(true)
    expect(await repository.getCategories()).toEqual(witchesCategories)
  })

  it('migre IndexedDB v5 avec produits déjà initialisés, IDs historiques et ventes intacts', async () => {
    const factory = new IDBFactory()
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('legacy', 5)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('products', { keyPath: 'id' }).add({
          ...witchesCatalogProducts[0],
          id: 'legacy',
          name: 'Personnalisé',
          categoryId: 'ancienne-categorie',
        })
        request.transaction!.objectStore('products').add(witchesCatalogProducts[1]!)
        request.result
          .createObjectStore('catalogMetadata', { keyPath: 'key' })
          .add({ key: 'catalog-initialized-v1', initializedAt: 'kept' })
        request.result
          .createObjectStore('orders', { keyPath: 'id' })
          .add({ id: 'old-sale', snapshot: 'immutable' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    legacy.close()
    const repository = new IndexedDbCatalogRepository(factory, 'legacy')
    const result = await repository.initialize(witchesCatalogProducts)
    expect(result.initialized).toBe(false)
    expect(result.products).toHaveLength(2)
    expect(result.products).toContainEqual(
      expect.objectContaining({
        id: 'legacy',
        categoryId: 'ancienne-categorie',
        name: 'Personnalisé',
      }),
    )
    const categories = await repository.getCategories()
    expect(categories.slice(0, 3)).toEqual(witchesCategories)
    expect(categories[3]).toMatchObject({ id: 'ancienne-categorie', active: false })
    await repository.updateCategory('potions', 'Menus personnalisés')
    await repository.setCategoryActive('potions', false)
    await repository.initialize(witchesCatalogProducts)
    expect(await repository.getCategories()).toHaveLength(4)
    expect((await repository.getCategories())[0]).toMatchObject({
      id: 'potions',
      label: 'Menus personnalisés',
      active: false,
    })
    const db = await openSamhainDatabase(factory, 'legacy')
    expect(db.version).toBe(6)
    const sale = await new Promise((resolve) => {
      const request = db.transaction('orders').objectStore('orders').get('old-sale')
      request.onsuccess = () => resolve(request.result)
    })
    expect(sale).toEqual({ id: 'old-sale', snapshot: 'immutable' })
    db.close()
  })
})
