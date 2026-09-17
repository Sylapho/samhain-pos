import type { Product } from '../types/catalog'
import type {
  CatalogInitializationResult,
  NativeCatalogStorageBridge,
} from '../native/catalogStorage'
import { indexedDbStores, openSamhainDatabase } from './indexedDbSchema'

const CATALOG_INITIALIZED_KEY = 'catalog-initialized-v1'

export interface CatalogRepository {
  initialize(seed: readonly Product[]): Promise<CatalogInitializationResult>
  getProducts(): Promise<Product[]>
  getSellableProducts(): Promise<Product[]>
  createProduct(product: Product): Promise<Product>
  updateProduct(product: Product): Promise<Product>
}

function sorted(products: Product[]): Product[] {
  return products.sort(
    (left, right) =>
      left.displayOrder - right.displayOrder ||
      left.name.localeCompare(right.name, 'fr-FR') ||
      left.id.localeCompare(right.id),
  )
}

function requestError(request: IDBRequest, fallback: string): Error {
  return request.error ?? new Error(fallback)
}

export class IndexedDbCatalogRepository implements CatalogRepository {
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = 'samhain-pos',
  ) {}

  async initialize(seed: readonly Product[]): Promise<CatalogInitializationResult> {
    const database = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [indexedDbStores.products, indexedDbStores.catalogMetadata],
        'readwrite',
      )
      const products = transaction.objectStore(indexedDbStores.products)
      const metadata = transaction.objectStore(indexedDbStores.catalogMetadata)
      const markerRequest = metadata.get(CATALOG_INITIALIZED_KEY)
      let initialized = false
      let operationError: unknown

      markerRequest.onsuccess = () => {
        if (markerRequest.result) return
        const countRequest = products.count()
        countRequest.onsuccess = () => {
          try {
            if (countRequest.result === 0) {
              for (const product of seed) products.add(structuredClone(product))
              initialized = true
            }
            metadata.put({ key: CATALOG_INITIALIZED_KEY, initializedAt: new Date().toISOString() })
          } catch (error) {
            operationError = error
            transaction.abort()
          }
        }
        countRequest.onerror = () => {
          operationError = requestError(countRequest, 'Initialisation du catalogue impossible.')
        }
      }
      markerRequest.onerror = () => {
        operationError = requestError(markerRequest, 'Lecture du catalogue impossible.')
      }
      transaction.oncomplete = () => {
        void this.getProducts().then(
          (storedProducts) => resolve({ initialized, products: storedProducts }),
          reject,
        )
      }
      transaction.onerror = () => {
        operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
      }
      transaction.onabort = () =>
        reject(operationError ?? transaction.error ?? new Error('Initialisation annulée.'))
    })
  }

  async getProducts(): Promise<Product[]> {
    const database = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(indexedDbStores.products, 'readonly')
      const request = transaction.objectStore(indexedDbStores.products).getAll()
      request.onsuccess = () => resolve(sorted(structuredClone(request.result as Product[])))
      request.onerror = () => reject(requestError(request, 'Lecture du catalogue impossible.'))
    })
  }

  async getSellableProducts(): Promise<Product[]> {
    return (await this.getProducts()).filter(
      ({ active, availability }) => active && availability === 'available',
    )
  }

  async createProduct(product: Product): Promise<Product> {
    return this.write(product, 'add')
  }

  async updateProduct(product: Product): Promise<Product> {
    const database = await this.openDatabase()
    const existing = await new Promise<Product | undefined>((resolve, reject) => {
      const request = database
        .transaction(indexedDbStores.products, 'readonly')
        .objectStore(indexedDbStores.products)
        .get(product.id)
      request.onsuccess = () => resolve(request.result as Product | undefined)
      request.onerror = () => reject(requestError(request, 'Lecture du produit impossible.'))
    })
    if (!existing) throw new Error('Ce produit n’existe plus dans le catalogue.')
    return this.write(product, 'put')
  }

  private async write(product: Product, method: 'add' | 'put'): Promise<Product> {
    const database = await this.openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(indexedDbStores.products, 'readwrite')
      const store = transaction.objectStore(indexedDbStores.products)
      const request =
        method === 'add' ? store.add(structuredClone(product)) : store.put(structuredClone(product))
      let operationError: unknown
      request.onerror = () => {
        operationError = requestError(request, 'Enregistrement du produit impossible.')
      }
      transaction.oncomplete = () => resolve(structuredClone(product))
      transaction.onerror = () => {
        operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
      }
      transaction.onabort = () =>
        reject(operationError ?? transaction.error ?? new Error('Enregistrement annulé.'))
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
}
