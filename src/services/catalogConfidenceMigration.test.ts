import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { initialCatalogProducts } from '../data/initialCatalog'
import { initialCategories } from '../data/initialCategories'
import { sha256Hex } from '../utils/integrity'
import type { Product } from '../types/catalog'
import { IndexedDbCatalogRepository } from './catalogRepository'
import { CatalogService } from './catalogService'
import { validateCatalogContent } from './catalogDistribution'

function version(revision = 1) {
  const payload = JSON.stringify({
    products: initialCatalogProducts,
    categories: initialCategories,
    id: `v${revision}`,
    revision,
    schemaVersion: 1,
    publishedAt: '2026-10-28T00:00:00Z',
    organizationId: 'test',
    festivalId: 'test',
    origin: 'fixture',
  })
  return { payload, sha256: sha256Hex(payload) }
}

function withoutConfidence(products: Product[]) {
  return products.map((product) => {
    const copy = structuredClone(product)
    delete copy.dataConfidence
    for (const variant of copy.variants ?? []) delete variant.dataConfidence
    return copy
  })
}

async function legacyInstallation() {
  const repo = new IndexedDbCatalogRepository(new IDBFactory(), 'confidence')
  await new CatalogService(repo).loadCatalog()
  const snapshot = await repo.readSnapshot()
  snapshot.products = snapshot.products.map((product, index) => ({
    ...product,
    name: `${product.name} personnalisé`,
    active: index % 2 === 0,
    availability: index % 2 === 0 ? 'sold-out' : 'available',
    dataConfidence: index % 2 === 0 ? 'temporary' : undefined,
    variants: product.variants?.map((variant, i) => ({
      ...variant,
      dataConfidence: i % 2 === 0 ? 'temporary' : undefined,
    })),
  }))
  const state = snapshot.distribution!
  delete state.publicationConfidenceMigratedV1
  state.active = version()
  state.pending = version(2)
  state.decisions = [
    { versionId: 'historic', at: 'now', choice: 'local', localRevision: 1, conflicts: [] },
  ]
  await repo.commitSnapshot(snapshot)
  return repo
}

describe('confirmation ponctuelle du catalogue', () => {
  it('confirme explicitement les produits initiaux et variantes et accepte leur publication', () => {
    for (const product of initialCatalogProducts) {
      expect(product.dataConfidence).toBe('confirmed')
      for (const variant of product.variants ?? []) expect(variant.dataConfidence).toBe('confirmed')
    }
  })

  it('préserve toutes les données hors confirmation et tout l’historique de distribution', async () => {
    const repo = await legacyInstallation()
    const before = await repo.readSnapshot()
    const sync = new CatalogService(repo).distribution
    await sync.initialize()
    const after = await repo.readSnapshot()
    expect(withoutConfidence(after.products)).toStrictEqual(withoutConfidence(before.products))
    expect(after.categories).toStrictEqual(before.categories)
    expect(after.distribution).toStrictEqual({
      ...before.distribution,
      publicationConfidenceMigratedV1: true,
    })
    expect(after.revision).toBe(before.revision + 1)
    for (const product of after.products) {
      expect(product.dataConfidence).toBe('confirmed')
      for (const variant of product.variants ?? []) expect(variant.dataConfidence).toBe('confirmed')
    }
    expect(() => validateCatalogContent(after, true)).not.toThrow()
    expect(() => validateCatalogContent(before, true)).toThrow()
    const publication = await sync.publicationContent()
    expect(() => validateCatalogContent(publication, true)).not.toThrow()
    await sync.initialize()
    expect(await repo.readSnapshot()).toStrictEqual(after)
  })

  it('conserve une déconfirmation et un nouveau produit après redémarrage', async () => {
    const repo = await legacyInstallation()
    const service = new CatalogService(repo)
    await service.loadCatalog()
    const existing = (await repo.getProducts())[0]!
    await service.updateProduct({ ...existing, dataConfidence: 'temporary' })
    await service.createProduct({ ...existing, id: 'new', dataConfidence: undefined })
    await new CatalogService(repo).loadCatalog()
    const rows = await repo.getProducts()
    expect(rows.find(({ id }) => id === existing.id)?.dataConfidence).toBe('temporary')
    expect(rows.find(({ id }) => id === 'new')?.dataConfidence).toBeUndefined()
    expect(() => validateCatalogContent({ products: rows, categories: [] }, true)).toThrow()
  })

  it('relit les éditions concurrentes après refus de révision', async () => {
    const repo = await legacyInstallation()
    const commit = repo.commitSnapshot.bind(repo)
    vi.spyOn(repo, 'commitSnapshot').mockImplementationOnce(async (snapshot) => {
      const product = (await repo.getProducts())[0]!
      await repo.updateProduct({ ...product, name: 'Édition concurrente', priceCents: 1234 })
      await commit(snapshot)
    })
    await new CatalogService(repo).distribution.initialize()
    expect(await repo.getProducts()).toContainEqual(
      expect.objectContaining({
        name: 'Édition concurrente',
        priceCents: 1234,
        dataConfidence: 'confirmed',
      }),
    )
  })

  it('ne mémorise pas une migration dont la transaction échoue', async () => {
    const repo = await legacyInstallation()
    const before = await repo.readSnapshot()
    vi.spyOn(repo, 'commitSnapshot').mockRejectedValueOnce(new Error('Écriture interrompue'))
    await expect(new CatalogService(repo).distribution.initialize()).rejects.toBeDefined()
    expect(await repo.readSnapshot()).toStrictEqual(before)
    await new CatalogService(repo).distribution.initialize()
    expect((await repo.readSnapshot()).distribution?.publicationConfidenceMigratedV1).toBe(true)
  })
})
