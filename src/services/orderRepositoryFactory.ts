import { Capacitor } from '@capacitor/core'
import { orderStorage } from '../native/orderStorage'
import {
  IndexedDbOrderRepository,
  type OrderRepository,
  type SalesLedgerRepository,
} from './orderRepository'
import { RoomOrderRepository } from './roomOrderRepository'

export type OrderDataRepository = OrderRepository & SalesLedgerRepository

export type RepositoryEnvironment = {
  platform?: string
  native?: boolean
  indexedDb?: IDBFactory
  nativeStorage?: ConstructorParameters<typeof RoomOrderRepository>[0]
}

export function createOrderDataRepository(
  environment: RepositoryEnvironment = {},
): OrderDataRepository {
  const platform = environment.platform ?? Capacitor.getPlatform()
  const native = environment.native ?? Capacitor.isNativePlatform()
  const indexedDb = environment.indexedDb ?? globalThis.indexedDB

  if (native && platform === 'android') {
    return new RoomOrderRepository(environment.nativeStorage ?? orderStorage, indexedDb)
  }
  if (!indexedDb) {
    throw new Error('Le stockage local durable IndexedDB est indisponible sur cet appareil.')
  }
  return new IndexedDbOrderRepository(indexedDb)
}

let defaultRepository: OrderDataRepository | null = null

export function getOrderDataRepository(): OrderDataRepository {
  defaultRepository ??= createOrderDataRepository()
  return defaultRepository
}
