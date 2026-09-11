import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Order, OrderPrinting } from '../types/order'
import type {
  ArchiveRestoreResult,
  ClosureLedgerEntry,
  ClosureRequest,
  CorrectionLedgerEntry,
  CorrectionRequest,
  LedgerSource,
} from '../types/salesLedger'
import type { OrderCreationRequest, OrderPersistenceSnapshot } from '../services/orderRepository'

export type LegacyMigrationStatus = {
  completed: boolean
  completedAt?: string
}

export type LegacyImportResult = {
  importedOrders: number
  importedEntries: number
  totalOrders: number
  totalEntries: number
}

export type PrintingUpdateResult = {
  updated: boolean
  order?: Order
}

export interface NativeOrderStorageBridge {
  getLegacyMigrationStatus(): Promise<LegacyMigrationStatus>
  importLegacySnapshot(options: { snapshot: OrderPersistenceSnapshot }): Promise<LegacyImportResult>
  createOrder(options: { request: OrderCreationRequest; source: LedgerSource }): Promise<Order>
  getSnapshot(): Promise<OrderPersistenceSnapshot>
  compareAndSetPrinting(options: {
    orderId: string
    expected: OrderPrinting
    printing: OrderPrinting
  }): Promise<PrintingUpdateResult>
  recordCorrection(options: { request: CorrectionRequest }): Promise<CorrectionLedgerEntry>
  closePeriod(options: { request: ClosureRequest }): Promise<ClosureLedgerEntry>
  restoreSnapshot(options: { snapshot: OrderPersistenceSnapshot }): Promise<ArchiveRestoreResult>
}

const nativePlugin = registerPlugin<NativeOrderStorageBridge>('OrderStorage')

export const orderStorage = {
  isAndroidNative(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  },
  getLegacyMigrationStatus: () => nativePlugin.getLegacyMigrationStatus(),
  importLegacySnapshot: (snapshot: OrderPersistenceSnapshot) =>
    nativePlugin.importLegacySnapshot({ snapshot }),
  createOrder: (request: OrderCreationRequest, source: LedgerSource) =>
    nativePlugin.createOrder({ request, source }),
  getSnapshot: () => nativePlugin.getSnapshot(),
  compareAndSetPrinting: (orderId: string, expected: OrderPrinting, printing: OrderPrinting) =>
    nativePlugin.compareAndSetPrinting({ orderId, expected, printing }),
  recordCorrection: (request: CorrectionRequest) => nativePlugin.recordCorrection({ request }),
  closePeriod: (request: ClosureRequest) => nativePlugin.closePeriod({ request }),
  restoreSnapshot: (snapshot: OrderPersistenceSnapshot) =>
    nativePlugin.restoreSnapshot({ snapshot }),
}
