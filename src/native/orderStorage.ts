import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Order, OrderPrinting } from '../types/order'
import type { CheckoutIntent } from '../types/checkout'
import type {
  ArchiveRestoreResult,
  CashFloatUpdatedLedgerEntry,
  CashSessionOpenedLedgerEntry,
  ClosureLedgerEntry,
  ClosureRequest,
  CorrectionLedgerEntry,
  CorrectionRequest,
  LedgerSource,
  OpenCashSessionRequest,
  UpdateCashFloatRequest,
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
  createCheckoutIntent(options: { intent: CheckoutIntent }): Promise<CheckoutIntent>
  getCheckoutIntents(): Promise<{ intents: CheckoutIntent[] }>
  markCheckoutPaymentToVerify(options: { id: string; updatedAt: string }): Promise<CheckoutIntent>
  confirmCheckoutPayment(options: { id: string; confirmedAt: string }): Promise<CheckoutIntent>
  abandonCheckoutIntent(options: { id: string; abandonedAt: string }): Promise<CheckoutIntent>
  finalizeCheckoutIntent(options: { id: string; updatedAt: string }): Promise<Order>
  getSnapshot(): Promise<OrderPersistenceSnapshot>
  compareAndSetPrinting(options: {
    orderId: string
    expected: OrderPrinting
    printing: OrderPrinting
  }): Promise<PrintingUpdateResult>
  openCashSession(options: {
    request: OpenCashSessionRequest
  }): Promise<CashSessionOpenedLedgerEntry>
  updateCashFloat(options: {
    request: UpdateCashFloatRequest
  }): Promise<CashFloatUpdatedLedgerEntry>
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
  createCheckoutIntent: (intent: CheckoutIntent) => nativePlugin.createCheckoutIntent({ intent }),
  getCheckoutIntents: () => nativePlugin.getCheckoutIntents(),
  markCheckoutPaymentToVerify: (id: string, updatedAt: string) =>
    nativePlugin.markCheckoutPaymentToVerify({ id, updatedAt }),
  confirmCheckoutPayment: (id: string, confirmedAt: string) =>
    nativePlugin.confirmCheckoutPayment({ id, confirmedAt }),
  abandonCheckoutIntent: (id: string, abandonedAt: string) =>
    nativePlugin.abandonCheckoutIntent({ id, abandonedAt }),
  finalizeCheckoutIntent: (id: string, updatedAt: string) =>
    nativePlugin.finalizeCheckoutIntent({ id, updatedAt }),
  getSnapshot: () => nativePlugin.getSnapshot(),
  compareAndSetPrinting: (orderId: string, expected: OrderPrinting, printing: OrderPrinting) =>
    nativePlugin.compareAndSetPrinting({ orderId, expected, printing }),
  openCashSession: (request: OpenCashSessionRequest) => nativePlugin.openCashSession({ request }),
  updateCashFloat: (request: UpdateCashFloatRequest) => nativePlugin.updateCashFloat({ request }),
  recordCorrection: (request: CorrectionRequest) => nativePlugin.recordCorrection({ request }),
  closePeriod: (request: ClosureRequest) => nativePlugin.closePeriod({ request }),
  restoreSnapshot: (snapshot: OrderPersistenceSnapshot) =>
    nativePlugin.restoreSnapshot({ snapshot }),
}
