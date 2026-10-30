import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { witchesCategories } from '../data/witchesCategories'
import type { Product } from '../types/catalog'
import type {
  CatalogContent,
  CatalogPublication,
  CatalogVersion,
} from '../types/catalogDistribution'
import { sha256Hex, canonicalJson } from '../utils/integrity'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbCatalogRepository } from './catalogRepository'
import { CatalogService } from './catalogService'
import { CatalogDistributionService } from './catalogDistributionService'
import { readCatalogVersion } from './catalogDistribution'
import { indexedDbStores, openSamhainDatabase } from './indexedDbSchema'

// Synthetic catalogue fixtures; no production price or composition is introduced.
const product: Product = {
  id: 'fixture',
  name: 'Test',
  priceCents: 500,
  vatRate: 10,
  categoryId: 'potions',
  active: true,
  displayOrder: 0,
  requiresPreparation: false,
  availability: 'available',
  dataConfidence: 'confirmed',
}
const scope = {
  organizationId: '00000000-0000-0000-0000-000000000001',
  festivalId: '10000000-0000-0000-0000-000000000001',
}
export function version(
  revision = 1,
  content: CatalogContent = { products: [product], categories: [...witchesCategories] },
): CatalogVersion {
  const publication: CatalogPublication = {
    ...content,
    ...scope,
    id: `version-${revision}`,
    revision,
    schemaVersion: 1,
    publishedAt: '2026-10-21T10:00:00Z',
    origin: 'api:fixture',
  }
  const payload = JSON.stringify(publication)
  return { payload, sha256: sha256Hex(payload) }
}
async function setup(seed = [product]) {
  const idb = new IDBFactory()
  const repo = new IndexedDbCatalogRepository(idb, 'distribution')
  const service = new CatalogService(repo, seed)
  await service.loadCatalog()
  return { idb, repo, service, sync: service.distribution }
}
async function put(idb: IDBFactory, store: string, value: unknown) {
  const db = await openSamhainDatabase(idb, 'distribution')
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

describe('distribution transactionnelle du catalogue', () => {
  it('simule A et B : deux publications, conflit explicite, rupture locale et activation au repos', async () => {
    const a = await setup()
    const b = await setup()
    const initial = version(1, await a.sync.publicationContent())
    await a.sync.stage(initial, scope)
    await b.sync.stage(initial, scope)
    await a.sync.activate(() => true)
    await b.sync.activate(() => true)
    await a.service.updateProduct({ ...product, name: 'Édition A', priceCents: 700 })
    await b.service.updateProduct({ ...product, name: 'Édition B', availability: 'sold-out' })
    const second = version(2, await a.sync.publicationContent())
    await b.sync.stage(second, scope)
    await expect(b.sync.activate(() => false)).rejects.toThrow('panier')
    expect((await b.service.getProducts())[0].name).toBe('Édition B')
    await b.sync.activate(() => true)
    expect((await b.sync.status()).conflicts).toEqual([
      expect.objectContaining({ field: 'name', local: 'Édition B', remote: 'Édition A' }),
    ])
    expect((await b.service.getProducts())[0]).toMatchObject({
      name: 'Édition B',
      priceCents: 700,
      availability: 'sold-out',
    })
    await b.sync.resolve('remote', () => true)
    expect((await b.service.getProducts())[0]).toMatchObject({
      name: 'Édition A',
      availability: 'sold-out',
    })
    expect(readCatalogVersion((await b.sync.status()).active!).revision).toBe(2)
  })
  it('initialise un cache vide et conserve les éditions après plusieurs jours hors connexion', async () => {
    const { idb, service } = await setup()
    await service.updateProduct({ ...product, name: 'Édition hors ligne', priceCents: 650 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01'))
    try {
      const restarted = new CatalogService(new IndexedDbCatalogRepository(idb, 'distribution'), [
        product,
      ])
      expect(await restarted.loadCatalog()).toMatchObject([
        { name: 'Édition hors ligne', priceCents: 650 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
  it('sépare téléchargement, staging durable et activation après redémarrage', async () => {
    const { idb, service, sync } = await setup()
    await sync.stage(
      version(1, {
        products: [{ ...product, priceCents: 700 }],
        categories: [...witchesCategories],
      }),
      scope,
    )
    expect((await service.getProducts())[0].priceCents).toBe(500)
    const restarted = new CatalogService(new IndexedDbCatalogRepository(idb, 'distribution'), [
      product,
    ])
    await restarted.loadCatalog()
    expect((await restarted.distribution.status()).pending).toBeDefined()
    await restarted.distribution.activate(() => true)
    const afterCommit = new CatalogService(new IndexedDbCatalogRepository(idb, 'distribution'), [
      product,
    ])
    expect((await afterCommit.loadCatalog())[0].priceCents).toBe(700)
    expect((await afterCommit.distribution.status()).pending).toBeUndefined()
  })
  it('ne fabrique aucune version si aucune publication n’existe', async () => {
    const { repo } = await setup()
    const sync = new CatalogDistributionService(repo, [product], {
      download: async () => ({ ...scope, version: null }),
    })
    await sync.download()
    expect((await sync.status()).active).toBeUndefined()
    expect((await sync.status()).pending).toBeUndefined()
  })
  it.each(['interrupted', 'revoked', 'expired'])(
    'conserve le dernier catalogue après transport %s',
    async (reason) => {
      const { repo, service } = await setup()
      const sync = new CatalogDistributionService(repo, [product], {
        download: async () => {
          throw new Error(reason)
        },
      })
      await expect(sync.download()).rejects.toThrow(reason)
      expect((await sync.status()).error).toBe('sync_error')
      expect((await service.getProducts())[0].priceCents).toBe(500)
      await service.updateProduct({ ...product, priceCents: 600 })
      expect((await service.getProducts())[0].priceCents).toBe(600)
    },
  )
  it.each([
    (v: CatalogVersion) => ({ ...v, payload: v.payload.slice(0, -10) }),
    (v: CatalogVersion) => ({ ...v, sha256: '0'.repeat(64) }),
    () =>
      version(1, {
        products: [{ ...product, categoryId: 'absent' }],
        categories: [...witchesCategories],
      }),
    () =>
      version(1, {
        products: [{ ...product, dataConfidence: 'temporary' }],
        categories: [...witchesCategories],
      }),
    () =>
      version(1, {
        products: [{ ...product, vatRate: 8 as Product['vatRate'] }],
        categories: [...witchesCategories],
      }),
    () =>
      version(1, {
        products: [{ ...product, active: 'true' as unknown as boolean }],
        categories: [...witchesCategories],
      }),
    () => version(1, { products: [product, product], categories: [...witchesCategories] }),
  ])('rejette une version invalide sans remplacer le staging valide (%#)', async (invalidate) => {
    const { service, sync } = await setup()
    const valid = version()
    await sync.stage(valid, scope)
    await expect(sync.stage(invalidate(version(2)), scope)).rejects.toThrow()
    expect((await sync.status()).pending).toEqual(valid)
    expect((await sync.status()).error).toBe('invalid_download')
    expect((await service.getProducts())[0].priceCents).toBe(500)
  })
  it('active une catégorie désactivée avec ses produits sans inventer de catégorie de remplacement', async () => {
    const { repo, sync } = await setup()
    await sync.stage(
      version(1, {
        products: [product],
        categories: witchesCategories.map((c) => (c.id === 'potions' ? { ...c, active: false } : c)),
      }),
      scope,
    )
    await sync.activate(() => true)
    expect(await repo.getActiveCategories()).not.toContainEqual(
      expect.objectContaining({ id: 'potions' }),
    )
    expect((await repo.getProducts())[0].categoryId).toBe('potions')
  })
  it('conserve chaque champ local concurrent et trace la décision responsable', async () => {
    const { service, sync, repo } = await setup()
    await sync.stage(version(), scope)
    await sync.activate(() => true)
    await service.updateProduct({
      ...product,
      priceCents: 650,
      ingredients: [{ id: 'local', name: 'Local' }],
      active: false,
      categoryId: 'gourmandises',
    })
    await sync.stage(
      version(2, {
        products: [
          {
            ...product,
            priceCents: 800,
            ingredients: [{ id: 'remote', name: 'Remote' }],
            categoryId: 'petit-marche',
          },
        ],
        categories: [...witchesCategories],
      }),
      scope,
    )
    // Use a real existing category in the remote reference.
    await sync.activate(() => true)
    expect((await service.getProducts())[0]).toMatchObject({
      priceCents: 650,
      active: false,
      categoryId: 'gourmandises',
    })
    expect((await sync.status()).conflicts.map(({ field }) => field)).toEqual(
      expect.arrayContaining(['priceCents', 'ingredients', 'categoryId']),
    )
    await sync.resolve('local', () => true)
    expect((await sync.status()).conflicts).toEqual([])
    expect((await sync.status()).decisions[0]).toMatchObject({
      versionId: 'version-2',
      choice: 'local',
    })
    expect((await repo.getProducts())[0].priceCents).toBe(650)
  })
  it('applique une décision distante explicite et refuse une décision sur une édition plus récente', async () => {
    const { service, sync } = await setup()
    await service.updateProduct({ ...product, priceCents: 650 })
    await sync.stage(
      version(1, {
        products: [{ ...product, priceCents: 800 }],
        categories: [...witchesCategories],
      }),
      scope,
    )
    await sync.activate(() => true)
    await sync.resolve('remote', () => true)
    expect((await service.getProducts())[0].priceCents).toBe(800)
    await service.updateProduct({ ...product, priceCents: 900 })
    await sync.stage(
      version(2, {
        products: [{ ...product, priceCents: 950 }],
        categories: [...witchesCategories],
      }),
      scope,
    )
    await sync.activate(() => true)
    await service.updateProduct({ ...product, priceCents: 1000 })
    await expect(sync.resolve('remote', () => true)).rejects.toThrow('plus récente')
    expect((await service.getProducts())[0].priceCents).toBe(1000)
  })
  it('sépare rupture locale et indisponibilité centrale pendant les éditions et mises à jour', async () => {
    const { service, sync, repo } = await setup()
    await sync.stage(
      version(1, {
        products: [{ ...product, availability: 'sold-out' }],
        categories: [...witchesCategories],
      }),
      scope,
    )
    await sync.activate(() => true)
    const visible = (await service.getProducts())[0]
    expect(visible).toMatchObject({ availability: 'sold-out', localAvailability: 'available' })
    await service.updateProduct({ ...visible, name: 'Renommé' })
    expect((await repo.getProducts())[0].availability).toBe('available')
    await sync.stage(version(2), scope)
    await sync.activate(() => true)
    expect((await service.getProducts())[0].availability).toBe('available')
    await service.updateProduct({
      ...(await service.getProducts())[0],
      localAvailability: 'sold-out',
    })
    await sync.stage(version(3), scope)
    await sync.activate(() => true)
    expect((await service.getProducts())[0].availability).toBe('sold-out')
    expect((await sync.publicationContent()).products[0].availability).toBe('available')
  })
  it.each(['panier actif', 'options ouvertes', 'paiement ouvert'])(
    'diffère activation et résolution avec %s',
    async () => {
      const { service, sync } = await setup()
      await sync.stage(
        version(1, {
          products: [{ ...product, priceCents: 800 }],
          categories: [...witchesCategories],
        }),
        scope,
      )
      await expect(sync.activate(() => false)).rejects.toThrow('Terminez')
      expect((await sync.status()).pending).toBeDefined()
      expect((await service.getProducts())[0].priceCents).toBe(500)
    },
  )
  it('vérifie les intentions persistées sous la transaction d’activation, même après redémarrage', async () => {
    const { idb, sync } = await setup()
    await sync.stage(version(), scope)
    await put(idb, indexedDbStores.checkoutIntents, { id: 'pending', status: 'payment_confirmed' })
    await expect(sync.activate(() => true)).rejects.toThrow('paiement')
    expect((await sync.status()).active).toBeUndefined()
    await put(idb, indexedDbStores.checkoutIntents, { id: 'pending', status: 'finalized' })
    await sync.activate(() => true)
    expect((await sync.status()).active).toBeDefined()
  })
  it('rejette un commit obsolète et ne perd aucune édition concurrente', async () => {
    const { repo, service } = await setup()
    const snapshot = await repo.readSnapshot()
    await service.updateProduct({ ...product, priceCents: 900 })
    await expect(repo.commitSnapshot(snapshot)).rejects.toThrow('CATALOG_CHANGED')
    expect((await service.getProducts())[0].priceCents).toBe(900)
  })
  it('annule toute activation si une catégorie provoque une erreur transactionnelle', async () => {
    const { repo, sync } = await setup()
    await sync.stage(version(), scope)
    const snapshot = await repo.readSnapshot()
    // IndexedDB DataCloneError after writes were queued must roll everything back.
    snapshot.categories.push({
      ...witchesCategories[0],
      id: 'bad',
      label: (() => 'bad') as unknown as string,
    })
    await expect(repo.commitSnapshot({ ...snapshot, activation: true })).rejects.toThrow()
    expect((await repo.readSnapshot()).revision).toBe(snapshot.revision)
    expect((await repo.readSnapshot()).categories).not.toContainEqual(
      expect.objectContaining({ id: 'bad' }),
    )
  })
  it('garde les snapshots de panier et ventes strictement identiques', async () => {
    const { idb, service, sync } = await setup()
    const cart = createCartItemDraft(product, { optionIdsByGroup: {} })
    const order = { id: 'historic', items: [cart], totalCents: cart.unitPriceCents }
    const before = canonicalJson(order)
    await put(idb, indexedDbStores.orders, order)
    await sync.stage(
      version(1, {
        products: [{ ...product, priceCents: 900 }],
        categories: [...witchesCategories],
      }),
      scope,
    )
    await sync.activate(() => true)
    const db = await openSamhainDatabase(idb, 'distribution')
    const stored = await new Promise((resolve) => {
      const request = db
        .transaction(indexedDbStores.orders)
        .objectStore(indexedDbStores.orders)
        .get('historic')
      request.onsuccess = () => resolve(request.result)
    })
    expect(canonicalJson(stored)).toBe(before)
    expect(cart.unitPriceCents).toBe(500)
    expect((await service.getProducts())[0].priceCents).toBe(900)
  })
  it('ne rejoue ni seed ni migration de prix/composition sur une version acceptée', async () => {
    const legacy: Product = { ...product, id: 'cafe', priceCents: 150 }
    const { service, sync } = await setup([legacy])
    expect((await service.getProducts())[0].priceCents).toBe(200)
    await sync.stage(version(1, { products: [legacy], categories: [...witchesCategories] }), scope)
    await sync.activate(() => true)
    expect((await service.loadCatalog())[0].priceCents).toBe(150)
    await service.updateProduct({ ...legacy, priceCents: 150 })
    expect((await service.loadCatalog())[0].priceCents).toBe(150)
  })
  it('refuse rollback, altération de révision et changement de périmètre', async () => {
    const { sync } = await setup()
    await sync.stage(version(2), scope)
    await sync.activate(() => true)
    await expect(sync.stage(version(1), scope)).rejects.toThrow('obsolète')
    await expect(
      sync.stage(
        version(2, {
          products: [{ ...product, priceCents: 999 }],
          categories: [...witchesCategories],
        }),
        scope,
      ),
    ).rejects.toThrow('différent')
    await expect(sync.stage(version(3), { ...scope, festivalId: 'other' })).rejects.toThrow()
    expect(readCatalogVersion((await sync.status()).active!).revision).toBe(2)
  })
})
