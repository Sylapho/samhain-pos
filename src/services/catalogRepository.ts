import { witchesCategories } from '../data/witchesCategories'
import type { Category, Product } from '../types/catalog'
import type { CatalogSnapshot, CatalogCommit } from '../types/catalogDistribution'
import type {
  CatalogInitializationResult,
  NativeCatalogStorageBridge,
} from '../native/catalogStorage'
import { indexedDbStores, openSamhainDatabase } from './indexedDbSchema'
import {
  normalizeCategoryLabel,
  reorderedCategories,
  sortCategories,
  validateCategory,
  validateProductCategory,
} from './categoryValidation'

const CATALOG_INITIALIZED_KEY = 'catalog-initialized-v1'

export interface CatalogRepository {
  readSnapshot(): Promise<CatalogSnapshot>
  commitSnapshot(snapshot: CatalogCommit): Promise<void>
  initialize(seed: readonly Product[]): Promise<CatalogInitializationResult>
  getProducts(): Promise<Product[]>
  getSellableProducts(): Promise<Product[]>
  createProduct(product: Product): Promise<Product>
  updateProduct(product: Product): Promise<Product>
  getCategories(): Promise<Category[]>
  getActiveCategories(): Promise<Category[]>
  createCategory(input: Pick<Category, 'id' | 'label'>): Promise<Category>
  updateCategory(id: string, label: string): Promise<Category>
  setCategoryActive(id: string, active: boolean): Promise<Category>
  reorderCategories(ids: readonly string[]): Promise<Category[]>
}

export function sorted(products: Product[]): Product[] {
  return products.sort(
    (a, b) =>
      a.displayOrder - b.displayOrder ||
      a.name.localeCompare(b.name, 'fr-FR') ||
      a.id.localeCompare(b.id),
  )
}

export class IndexedDbCatalogRepository implements CatalogRepository {
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = 'samhain-witches',
  ) {}

  async initialize(seed: readonly Product[]): Promise<CatalogInitializationResult> {
    let initialized = false
    await this.catalogTransaction((products, categories, metadata) => {
      const marker = metadata.get(CATALOG_INITIALIZED_KEY)
      marker.onsuccess = () => {
        const stored = products.getAll()
        stored.onsuccess = () => {
          if (!marker.result) {
            if (!stored.result.length) {
              for (const product of seed) products.add(structuredClone(product))
              initialized = true
            }
            metadata.put({ key: CATALOG_INITIALIZED_KEY, initializedAt: new Date().toISOString() })
          }
          const allProducts =
            stored.result.length || marker.result ? (stored.result as Product[]) : [...seed]
          const request = categories.getAll()
          request.onsuccess = () => {
            const existing = request.result as Category[]
            const ensure = (category: Category) => {
              if (existing.some(({ id }) => id === category.id)) return
              // Preserve customized names, including collisions with missing seeds.
              let label = category.label
              while (
                existing.some(
                  (other) => normalizeCategoryLabel(other.label) === normalizeCategoryLabel(label),
                )
              )
                label += ` (${category.id})`
              const added = { ...category, label }
              categories.add(added)
              existing.push(added)
            }
            const distribution = metadata.get('distribution-v1')
            distribution.onsuccess = () => {
              if (!distribution.result)
                for (const category of witchesCategories) ensure(structuredClone(category))
              for (const product of allProducts)
                ensure({
                  id: product.categoryId,
                  label: product.categoryId,
                  active: false,
                  displayOrder:
                    Math.max(-1, ...existing.map(({ displayOrder }) => displayOrder)) + 1,
                })
            }
          }
        }
      }
    })
    return { initialized, products: await this.getProducts() }
  }

  async getProducts(): Promise<Product[]> {
    return sorted(await this.readAll<Product>(indexedDbStores.products))
  }

  async readSnapshot(): Promise<CatalogSnapshot> {
    const db = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction([
        indexedDbStores.products,
        indexedDbStores.categories,
        indexedDbStores.catalogMetadata,
      ])
      const products = tx.objectStore(indexedDbStores.products).getAll()
      const categories = tx.objectStore(indexedDbStores.categories).getAll()
      const state = tx.objectStore(indexedDbStores.catalogMetadata).get('distribution-v1')
      const revision = tx.objectStore(indexedDbStores.catalogMetadata).get('local-revision')
      tx.oncomplete = () =>
        resolve({
          products: products.result,
          categories: categories.result,
          distribution: state.result?.value ?? null,
          revision: revision.result?.value ?? 0,
        })
      tx.onabort = () => reject(tx.error)
    })
  }

  async commitSnapshot(snapshot: CatalogCommit): Promise<void> {
    await this.catalogTransaction((products, categories, metadata, fail, tx) => {
      const revision = metadata.get('local-revision')
      revision.onsuccess = () => {
        // catalogTransaction has already queued the revision increment, invisible until commit.
        if ((revision.result?.value ?? 0) !== snapshot.revision + 1)
          return fail(new Error('CATALOG_CHANGED'))
        const apply = () => {
          for (const category of snapshot.categories) categories.put(structuredClone(category))
          for (const product of snapshot.products) products.put(structuredClone(product))
          metadata.put({ key: 'distribution-v1', value: structuredClone(snapshot.distribution) })
        }
        if (!snapshot.activation) return apply()
        const intents = tx.objectStore(indexedDbStores.checkoutIntents).getAll()
        intents.onsuccess = () => {
          if (
            intents.result.some(
              (intent: { status: string }) => !['finalized', 'abandoned'].includes(intent.status),
            )
          )
            return fail(new Error('Un paiement doit être terminé avant l’activation.'))
          apply()
        }
      }
    })
  }

  async getSellableProducts(): Promise<Product[]> {
    return (await this.getProducts()).filter(
      ({ active, availability }) => active && availability === 'available',
    )
  }

  async getCategories(): Promise<Category[]> {
    return sortCategories(await this.readAll<Category>(indexedDbStores.categories))
  }

  async getActiveCategories(): Promise<Category[]> {
    return (await this.getCategories()).filter(({ active }) => active)
  }

  async createCategory(input: Pick<Category, 'id' | 'label'>): Promise<Category> {
    let result!: Category
    await this.mutateCategories((existing) => {
      if (existing.some(({ id }) => id === input.id))
        throw new Error('Cet identifiant de catégorie existe déjà.')
      result = validateCategory(
        {
          ...input,
          active: true,
          displayOrder: Math.max(-1, ...existing.map(({ displayOrder }) => displayOrder)) + 1,
        },
        existing,
      )
      return [result]
    })
    return result
  }

  updateCategory(id: string, label: string): Promise<Category> {
    return this.changeCategory(id, { label })
  }

  setCategoryActive(id: string, active: boolean): Promise<Category> {
    return this.changeCategory(id, { active })
  }

  async reorderCategories(ids: readonly string[]): Promise<Category[]> {
    let result!: Category[]
    await this.mutateCategories((existing) => (result = reorderedCategories(existing, ids)))
    return result
  }

  private async changeCategory(
    id: string,
    update: Partial<Pick<Category, 'label' | 'active'>>,
  ): Promise<Category> {
    let result!: Category
    await this.mutateCategories((existing) => {
      const previous = existing.find((category) => category.id === id)
      if (!previous) throw new Error('Cette catégorie n’existe plus.')
      result = validateCategory({ ...previous, ...update }, existing)
      return [result]
    })
    return result
  }

  private async mutateCategories(change: (categories: Category[]) => Category[]): Promise<void> {
    await this.catalogTransaction((_products, categories, _metadata, fail) => {
      const request = categories.getAll()
      request.onsuccess = () => {
        try {
          for (const category of change(request.result as Category[])) categories.put(category)
        } catch (error) {
          fail(error)
        }
      }
    })
  }

  createProduct(product: Product): Promise<Product> {
    return this.write(product, 'add')
  }
  updateProduct(product: Product): Promise<Product> {
    return this.write(product, 'put')
  }

  private async write(product: Product, method: 'add' | 'put'): Promise<Product> {
    await this.catalogTransaction((products, categories, _metadata, fail) => {
      const previous = products.get(product.id)
      previous.onsuccess = () => {
        const request = categories.getAll()
        request.onsuccess = () => {
          try {
            if (method === 'put' && !previous.result)
              throw new Error('Ce produit n’existe plus dans le catalogue.')
            validateProductCategory(
              product,
              request.result as Category[],
              method === 'put' ? (previous.result as Product) : undefined,
            )
            if (method === 'add') products.add(structuredClone(product))
            else products.put(structuredClone(product))
          } catch (error) {
            fail(error)
          }
        }
      }
    })
    return structuredClone(product)
  }

  private async readAll<T>(store: string): Promise<T[]> {
    const database = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const request = database.transaction(store).objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => reject(request.error ?? new Error('Lecture du catalogue impossible.'))
    })
  }

  // Shared scope allows atomic category + product activation in #115.
  private async catalogTransaction(
    operation: (
      products: IDBObjectStore,
      categories: IDBObjectStore,
      metadata: IDBObjectStore,
      fail: (error: unknown) => void,
      transaction: IDBTransaction,
    ) => void,
  ): Promise<void> {
    const database = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [
          indexedDbStores.products,
          indexedDbStores.categories,
          indexedDbStores.catalogMetadata,
          indexedDbStores.checkoutIntents,
        ],
        'readwrite',
      )
      let operationError: unknown
      const fail = (error: unknown) => {
        operationError = error
        transaction.abort()
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        operationError ??= transaction.error
      }
      transaction.onabort = () =>
        reject(
          operationError ?? transaction.error ?? new Error('Enregistrement du catalogue annulé.'),
        )
      try {
        const metadata = transaction.objectStore(indexedDbStores.catalogMetadata)
        const revision = metadata.get('local-revision')
        revision.onsuccess = () => {
          metadata.put({ key: 'local-revision', value: (revision.result?.value ?? 0) + 1 })
          operation(
            transaction.objectStore(indexedDbStores.products),
            transaction.objectStore(indexedDbStores.categories),
            transaction.objectStore(indexedDbStores.catalogMetadata),
            fail,
            transaction,
          )
        }
      } catch (error) {
        fail(error)
      }
    })
  }

  private openDatabase(): Promise<IDBDatabase> {
    this.databasePromise ??= openSamhainDatabase(this.indexedDb, this.databaseName).catch(
      (error) => {
        this.databasePromise = null
        throw error
      },
    )
    return this.databasePromise
  }
}

export class RoomCatalogRepository implements CatalogRepository {
  constructor(private readonly bridge: NativeCatalogStorageBridge) {}
  readSnapshot(): Promise<CatalogSnapshot> {
    return this.bridge.getCatalogSnapshot()
  }
  commitSnapshot(snapshot: CatalogCommit): Promise<void> {
    return this.bridge.commitCatalogSnapshot({ snapshot }).then(() => undefined)
  }
  initialize(seed: readonly Product[]): Promise<CatalogInitializationResult> {
    return this.bridge.initializeCatalog({ products: structuredClone([...seed]) })
  }
  getProducts(): Promise<Product[]> {
    return this.bridge.getCatalogProducts().then(({ products }) => sorted(products))
  }
  getSellableProducts(): Promise<Product[]> {
    return this.bridge.getSellableCatalogProducts().then(({ products }) => sorted(products))
  }
  createProduct(product: Product): Promise<Product> {
    return this.bridge.createCatalogProduct({ product: structuredClone(product) })
  }
  updateProduct(product: Product): Promise<Product> {
    return this.bridge.updateCatalogProduct({ product: structuredClone(product) })
  }
  getCategories(): Promise<Category[]> {
    return this.bridge.getCatalogCategories().then(({ categories }) => sortCategories(categories))
  }
  async getActiveCategories(): Promise<Category[]> {
    return (await this.getCategories()).filter(({ active }) => active)
  }
  createCategory(input: Pick<Category, 'id' | 'label'>): Promise<Category> {
    return this.bridge.createCatalogCategory({ category: input })
  }
  updateCategory(id: string, label: string): Promise<Category> {
    return this.bridge.updateCatalogCategory({ id, label })
  }
  setCategoryActive(id: string, active: boolean): Promise<Category> {
    return this.bridge.setCatalogCategoryActive({ id, active })
  }
  reorderCategories(ids: readonly string[]): Promise<Category[]> {
    return this.bridge
      .reorderCatalogCategories({ ids: [...ids] })
      .then(({ categories }) => sortCategories(categories))
  }
}
