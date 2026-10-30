import { validateProduct } from './productValidation'
export { validateProduct } from './productValidation'
import { Capacitor } from '@capacitor/core'
import { witchesCatalogProducts } from '../data/witchesCatalog'
import { catalogStorage } from '../native/catalogStorage'
import { type Category, type Product } from '../types/catalog'
import {
  IndexedDbCatalogRepository,
  RoomCatalogRepository,
  type CatalogRepository,
  sorted,
} from './catalogRepository'
import { CatalogDistributionService } from './catalogDistributionService'

function localProduct(product: Product): Product {
  const local = { ...product, availability: product.localAvailability ?? product.availability }
  delete local.localAvailability
  delete local.centralAvailability
  return validateProduct(local)
}

export class CatalogService {
  readonly distribution: CatalogDistributionService
  constructor(
    private readonly repository: CatalogRepository,
    private readonly seed: readonly Product[] = witchesCatalogProducts,
  ) {
    this.distribution = new CatalogDistributionService(repository, seed)
  }

  async loadCatalog(): Promise<Product[]> {
    await this.repository.initialize(this.seed.map(validateProduct))
    await this.distribution.initialize()
    return this.getProducts()
  }

  getCategories(): Promise<Category[]> {
    return this.repository.getCategories()
  }
  getActiveCategories(): Promise<Category[]> {
    return this.repository.getActiveCategories()
  }
  createCategory(label: string): Promise<Category> {
    return this.repository.createCategory({ id: globalThis.crypto.randomUUID(), label })
  }
  updateCategory(id: string, label: string): Promise<Category> {
    return this.repository.updateCategory(id, label)
  }
  setCategoryActive(id: string, active: boolean): Promise<Category> {
    return this.repository.setCategoryActive(id, active)
  }
  reorderCategories(ids: readonly string[]): Promise<Category[]> {
    return this.repository.reorderCategories(ids)
  }

  async getProducts(): Promise<Product[]> {
    return sorted((await this.distribution.products()).map(validateProduct))
  }

  async getSellableProducts(): Promise<Product[]> {
    return (await this.getProducts()).filter(
      ({ active, availability }) => active && availability === 'available',
    )
  }

  async createProduct(product: Product): Promise<Product> {
    return this.repository.createProduct(localProduct(product))
  }

  async updateProduct(product: Product): Promise<Product> {
    return this.repository.updateProduct(localProduct(product))
  }

  async setProductActive(product: Product, active: boolean): Promise<Product> {
    return this.updateProduct({ ...product, active })
  }
}

let defaultService: CatalogService | null = null

export function getCatalogService(): CatalogService {
  if (defaultService) return defaultService
  const native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  if (native) {
    defaultService = new CatalogService(new RoomCatalogRepository(catalogStorage))
  } else {
    if (!globalThis.indexedDB) {
      throw new Error('Le stockage local durable du catalogue est indisponible.')
    }
    defaultService = new CatalogService(new IndexedDbCatalogRepository(globalThis.indexedDB))
  }
  return defaultService
}
