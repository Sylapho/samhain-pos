import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Product } from '../types/catalog'

export type CatalogInitializationResult = {
  initialized: boolean
  products: Product[]
}

export interface NativeCatalogStorageBridge {
  initializeCatalog(options: { products: Product[] }): Promise<CatalogInitializationResult>
  getCatalogProducts(): Promise<{ products: Product[] }>
  getSellableCatalogProducts(): Promise<{ products: Product[] }>
  createCatalogProduct(options: { product: Product }): Promise<Product>
  updateCatalogProduct(options: { product: Product }): Promise<Product>
}

const nativePlugin = registerPlugin<NativeCatalogStorageBridge>('CatalogStorage')

export const catalogStorage = {
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
