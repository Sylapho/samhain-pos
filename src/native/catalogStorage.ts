import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Category, Product } from '../types/catalog'
import type { CatalogSnapshot, CatalogCommit, CatalogVersion } from '../types/catalogDistribution'

export type CatalogInitializationResult = {
  initialized: boolean
  products: Product[]
}

export interface NativeCatalogStorageBridge {
  getCatalogSnapshot(): Promise<CatalogSnapshot>
  commitCatalogSnapshot(options: { snapshot: CatalogCommit }): Promise<{ updated: boolean }>
  downloadCatalog(): Promise<{
    version: CatalogVersion | null
    organizationId: string
    festivalId: string
  }>
  publishCatalog(options: {
    email: string
    password: string
    body: {
      organizationId: string
      festivalId: string
      expectedRevision: number
      products: Product[]
      categories: Category[]
    }
  }): Promise<{ version: CatalogVersion }>
  getCatalogCategories(): Promise<{ categories: Category[] }>
  createCatalogCategory(options: { category: Pick<Category, 'id' | 'label'> }): Promise<Category>
  updateCatalogCategory(options: { id: string; label: string }): Promise<Category>
  setCatalogCategoryActive(options: { id: string; active: boolean }): Promise<Category>
  reorderCatalogCategories(options: { ids: string[] }): Promise<{ categories: Category[] }>
  initializeCatalog(options: { products: Product[] }): Promise<CatalogInitializationResult>
  getCatalogProducts(): Promise<{ products: Product[] }>
  getSellableCatalogProducts(): Promise<{ products: Product[] }>
  createCatalogProduct(options: { product: Product }): Promise<Product>
  updateCatalogProduct(options: { product: Product }): Promise<Product>
}

const nativePlugin = registerPlugin<NativeCatalogStorageBridge>('CatalogStorage')

export const catalogStorage = {
  getCatalogSnapshot: () => nativePlugin.getCatalogSnapshot(),
  commitCatalogSnapshot: (options: { snapshot: CatalogCommit }) =>
    nativePlugin.commitCatalogSnapshot(options),
  downloadCatalog: () => nativePlugin.downloadCatalog(),
  publishCatalog: (options: Parameters<NativeCatalogStorageBridge['publishCatalog']>[0]) =>
    nativePlugin.publishCatalog(options),
  getCatalogCategories: () => nativePlugin.getCatalogCategories(),
  createCatalogCategory: (options: { category: Pick<Category, 'id' | 'label'> }) =>
    nativePlugin.createCatalogCategory(options),
  updateCatalogCategory: (options: { id: string; label: string }) =>
    nativePlugin.updateCatalogCategory(options),
  setCatalogCategoryActive: (options: { id: string; active: boolean }) =>
    nativePlugin.setCatalogCategoryActive(options),
  reorderCatalogCategories: (options: { ids: string[] }) =>
    nativePlugin.reorderCatalogCategories(options),
  isAndroidNative(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  },
  initializeCatalog: (options: { products: Product[] }) => nativePlugin.initializeCatalog(options),
  getCatalogProducts: () => nativePlugin.getCatalogProducts(),
  getSellableCatalogProducts: () => nativePlugin.getSellableCatalogProducts(),
  createCatalogProduct: (options: { product: Product }) =>
    nativePlugin.createCatalogProduct(options),
  updateCatalogProduct: (options: { product: Product }) =>
    nativePlugin.updateCatalogProduct(options),
}
