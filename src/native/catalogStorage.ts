import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Category, Product } from '../types/catalog'

export type CatalogInitializationResult = {
  initialized: boolean
  products: Product[]
}

export interface NativeCatalogStorageBridge {
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
