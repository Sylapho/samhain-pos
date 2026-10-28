import { initialCategories } from '../data/initialCategories'
import { confirmedCatalogProduct } from '../data/confirmedCatalogProduct'
import { catalogStorage } from '../native/catalogStorage'
import type { Product } from '../types/catalog'
import type {
  CatalogContent,
  CatalogDistributionState,
  CatalogSnapshot,
  CatalogVersion,
} from '../types/catalogDistribution'
import type { CatalogRepository } from './catalogRepository'
import {
  effectiveProducts,
  mergeCatalog,
  readCatalogVersion,
  validateCatalogContent,
} from './catalogDistribution'
import { migrateConfirmedCatalogPrices } from './catalogPriceMigration'
import { canonicalJson } from '../utils/integrity'

function migrateLegacy(product: Product): Product {
  return migrateConfirmedCatalogPrices(
    product.id === 'burger-samhain' && product.ingredients?.length
      ? { ...product, ingredients: undefined }
      : product,
  )
}

export type CatalogTransport = {
  download(): Promise<{
    version: CatalogVersion | null
    organizationId: string
    festivalId: string
  }>
}
const nativeTransport: CatalogTransport = {
  download: () => {
    if (!catalogStorage.isAndroidNative())
      throw new Error('Les échanges sécurisés nécessitent une tablette Android enrôlée.')
    return catalogStorage.downloadCatalog()
  },
}

export class CatalogDistributionService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly seed: readonly Product[],
    private readonly transport: CatalogTransport = nativeTransport,
  ) {}

  private async mutate(
    change: (snapshot: CatalogSnapshot, state: CatalogDistributionState) => boolean,
    activation = false,
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.repository.readSnapshot()
      const state = snapshot.distribution
      if (!state) throw new Error('Chargez d’abord le catalogue local.')
      if (!change(snapshot, state)) return
      try {
        await this.repository.commitSnapshot({ ...snapshot, activation })
        return
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('CATALOG_CHANGED')) throw error
      }
    }
    throw new Error('Le catalogue a changé. Réessayez après les modifications locales.')
  }

  async initialize(): Promise<void> {
    await this.initializeLegacy()
    await this.mutate((snapshot, state) => {
      if (state.publicationConfidenceMigratedV1) return false
      snapshot.products = snapshot.products.map(confirmedCatalogProduct)
      // Keep published envelopes, merge bases and history unchanged. The marker and
      // local products commit atomically under the repository's revision check.
      state.publicationConfidenceMigratedV1 = true
      return true
    })
  }

  private async initializeLegacy(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.repository.readSnapshot()
      if (snapshot.distribution?.legacyMigrated) return
      const products = snapshot.products.map(migrateLegacy)
      const distribution: CatalogDistributionState = {
        legacyMigrated: true,
        base: {
          products: this.seed.map(migrateLegacy),
          categories: structuredClone([...initialCategories]),
        },
        conflicts: [],
        decisions: [],
      }
      try {
        await this.repository.commitSnapshot({ ...snapshot, products, distribution })
        return
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('CATALOG_CHANGED')) throw error
      }
    }
    throw new Error('Initialisation du catalogue interrompue. Réessayez.')
  }

  async status(): Promise<CatalogDistributionState> {
    const state = (await this.repository.readSnapshot()).distribution
    if (!state) throw new Error('Catalogue non initialisé.')
    return state
  }

  async products(): Promise<Product[]> {
    const snapshot = await this.repository.readSnapshot()
    return effectiveProducts(snapshot, snapshot.distribution?.active)
  }

  async download(): Promise<void> {
    try {
      const response = await this.transport.download()
      if (response.version) await this.stage(response.version, response)
      else
        await this.mutate((_snapshot, state) => {
          delete state.error
          return true
        })
    } catch (error) {
      await this.mutate((_snapshot, state) => {
        state.error ??= 'sync_error'
        return true
      })
      throw error
    }
  }

  async stage(
    version: CatalogVersion,
    scope: { organizationId: string; festivalId: string },
  ): Promise<void> {
    try {
      const publication = readCatalogVersion(version, scope)
      await this.mutate((_snapshot, state) => {
        for (const known of [state.active, state.pending]) {
          if (!known) continue
          const previous = readCatalogVersion(known, scope)
          if (previous.revision > publication.revision)
            throw new Error('Révision distante obsolète.')
          if (previous.revision === publication.revision) {
            if (known.sha256 !== version.sha256)
              throw new Error('Cette révision possède un contenu différent.')
            return false
          }
        }
        state.pending = structuredClone(version)
        delete state.error
        return true
      })
    } catch (error) {
      await this.mutate((_snapshot, state) => {
        state.error = 'invalid_download'
        return true
      })
      throw error
    }
  }

  // The caller holds the UI operation gate throughout commit AND rendering the new catalogue.
  // Persistence checks durable CheckoutIntents in the same database transaction.
  async activate(isSafe: () => boolean): Promise<void> {
    await this.mutate((snapshot, state) => {
      if (!isSafe())
        throw new Error(
          'Terminez le panier, les options et le paiement avant d’activer la mise à jour.',
        )
      if (state.conflicts.length)
        throw new Error('Résolvez les conflits de la version active avant la prochaine activation.')
      if (!state.pending) return false
      const remote = readCatalogVersion(state.pending)
      const merged = mergeCatalog(state.base, snapshot, remote)
      snapshot.products = merged.content.products
      snapshot.categories = merged.content.categories
      state.conflicts = merged.conflicts
      state.base = { products: remote.products, categories: remote.categories }
      state.active = state.pending
      delete state.pending
      delete state.error
      return true
    }, true)
  }

  async resolve(choice: 'local' | 'remote', isSafe: () => boolean): Promise<void> {
    await this.mutate((snapshot, state) => {
      if (!isSafe())
        throw new Error('Terminez l’opération en cours avant de résoudre les conflits.')
      if (!state.active || !state.conflicts.length) return false
      // Re-read current values under CAS: a newer edit is never replaced using a stale decision.
      for (const conflict of state.conflicts) {
        const row = snapshot[conflict.entity].find(({ id }) => id === conflict.id)
        if (!row) throw new Error('Rechargez le catalogue avant de résoudre les conflits.')
        if (choice === 'remote') {
          const current = (row as Record<string, unknown>)[conflict.field] ?? null
          if (canonicalJson(current) !== canonicalJson(conflict.local))
            throw new Error(
              'Une édition locale plus récente existe. Conservez-la puis vérifiez cette édition.',
            )
          if (conflict.remote === null) delete (row as Record<string, unknown>)[conflict.field]
          else (row as Record<string, unknown>)[conflict.field] = structuredClone(conflict.remote)
        } else conflict.local = (row as Record<string, unknown>)[conflict.field] ?? null
      }
      validateCatalogContent(snapshot, false)
      state.decisions.push({
        versionId: readCatalogVersion(state.active).id,
        at: new Date().toISOString(),
        choice,
        localRevision: snapshot.revision + 1,
        conflicts: structuredClone(state.conflicts),
      })
      state.conflicts = []
      return true
    }, true)
  }

  async publicationContent(): Promise<CatalogContent> {
    const snapshot = await this.repository.readSnapshot()
    // Local stock overlays are never proposed as global availability.
    const central = snapshot.distribution?.base.products ?? []
    return {
      categories: snapshot.categories,
      products: snapshot.products.map((product) => ({
        ...product,
        availability: central.find(({ id }) => id === product.id)?.availability ?? 'available',
      })),
    }
  }
}
