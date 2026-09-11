import type { Order, OrderPrinting } from '../types/order'
import {
  SALES_ARCHIVE_SCHEMA_VERSION,
  type ArchiveRestoreResult,
  type ClosureLedgerEntry,
  type ClosureRequest,
  type CorrectionLedgerEntry,
  type CorrectionRequest,
  type IntegrityVerification,
  type LedgerSource,
  type SalesArchive,
  type SalesLedgerEntry,
  type StoredOrderTechnicalState,
} from '../types/salesLedger'
import { hashCanonicalValue } from '../utils/integrity'
import { orderStorage, type NativeOrderStorageBridge } from '../native/orderStorage'
import {
  ARCHIVE_NOTICE,
  IndexedDbOrderRepository,
  type OrderCreationRequest,
  type OrderPersistenceSnapshot,
  type OrderRepository,
  type SalesLedgerRepository,
  type StoredOrder,
  toImmutableOrderSnapshot,
  verifyAuditSnapshot,
  verifySalesArchive,
} from './orderRepository'

type NativeStorage = {
  getLegacyMigrationStatus: NativeOrderStorageBridge['getLegacyMigrationStatus']
  importLegacySnapshot(
    snapshot: OrderPersistenceSnapshot,
  ): ReturnType<NativeOrderStorageBridge['importLegacySnapshot']>
  createOrder(request: OrderCreationRequest, source: LedgerSource): Promise<Order>
  getSnapshot(): Promise<OrderPersistenceSnapshot>
  compareAndSetPrinting(
    orderId: string,
    expected: OrderPrinting,
    printing: OrderPrinting,
  ): ReturnType<NativeOrderStorageBridge['compareAndSetPrinting']>
  recordCorrection(request: CorrectionRequest): Promise<CorrectionLedgerEntry>
  closePeriod(request: ClosureRequest): Promise<ClosureLedgerEntry>
  restoreSnapshot(snapshot: OrderPersistenceSnapshot): Promise<ArchiveRestoreResult>
}

function unknownPrinting(createdAt: string): OrderPrinting {
  return {
    status: 'unknown',
    customerReceipt: 'unknown',
    preparationTicket: 'unknown',
    attempts: 0,
    updatedAt: createdAt,
    lastError: 'État d’impression antérieur inconnu.',
  }
}

function hydrateOrder(stored: StoredOrder, technical?: StoredOrderTechnicalState): Order {
  return {
    ...toImmutableOrderSnapshot(stored),
    ...(stored.integrity ? { integrity: structuredClone(stored.integrity) } : {}),
    printing: structuredClone(
      technical?.printing ?? stored.printing ?? unknownPrinting(stored.createdAt),
    ),
  }
}

export class RoomOrderRepository implements OrderRepository, SalesLedgerRepository {
  private initialization: Promise<void> | null = null

  constructor(
    private readonly nativeStorage: NativeStorage = orderStorage,
    private readonly legacyIndexedDb: IDBFactory | undefined = globalThis.indexedDB,
    private readonly legacyDatabaseName = 'samhain-pos',
  ) {}

  async createOrder(request: OrderCreationRequest, source: LedgerSource): Promise<Order> {
    await this.ensureInitialized()
    return this.nativeStorage.createOrder(request, source)
  }

  async getOrders(): Promise<Order[]> {
    const snapshot = await this.getSnapshot()
    const technicalByOrder = new Map(
      snapshot.technicalStates.map((technical) => [technical.orderId, technical]),
    )
    return snapshot.orders.map((stored) => hydrateOrder(stored, technicalByOrder.get(stored.id)))
  }

  async updateOrderPrinting(
    id: string,
    update: (printing: OrderPrinting) => OrderPrinting,
  ): Promise<Order> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = (await this.getOrders()).find((order) => order.id === id)
      if (!current) throw new Error(`Commande locale ${id} introuvable.`)
      const printing = update(structuredClone(current.printing))
      const result = await this.nativeStorage.compareAndSetPrinting(id, current.printing, printing)
      if (result.updated && result.order) return result.order
    }
    throw new Error('L’état d’impression a été modifié simultanément. Réessayez l’opération.')
  }

  async recordCorrection(request: CorrectionRequest): Promise<CorrectionLedgerEntry> {
    await this.ensureInitialized()
    return this.nativeStorage.recordCorrection(request)
  }

  async closePeriod(request: ClosureRequest): Promise<ClosureLedgerEntry> {
    await this.ensureInitialized()
    return this.nativeStorage.closePeriod(request)
  }

  async getLedgerEntries(): Promise<SalesLedgerEntry[]> {
    return (await this.getSnapshot()).entries.sort((left, right) => left.sequence - right.sequence)
  }

  async verifyIntegrity(): Promise<IntegrityVerification> {
    return verifyAuditSnapshot(await this.getSnapshot())
  }

  async exportArchive(
    archiveId: string,
    exportedAt: string,
    source: LedgerSource,
  ): Promise<SalesArchive> {
    const snapshot = await this.getSnapshot()
    const verification = verifyAuditSnapshot(snapshot)
    if (!verification.valid) throw new Error(`Export refusé : ${verification.errors.join(' ')}`)
    const archiveWithoutDigest: Omit<SalesArchive, 'archiveHash'> = {
      schemaVersion: SALES_ARCHIVE_SCHEMA_VERSION,
      archiveId,
      exportedAt,
      notice: ARCHIVE_NOTICE,
      source: structuredClone(source),
      metadata: snapshot.metadata,
      orders: snapshot.orders.map((order) => ({
        ...toImmutableOrderSnapshot(order),
        ...(order.integrity ? { integrity: structuredClone(order.integrity) } : {}),
      })),
      technicalStates: structuredClone(snapshot.technicalStates),
      entries: structuredClone(snapshot.entries).sort(
        (left, right) => left.sequence - right.sequence,
      ),
    }
    return { ...archiveWithoutDigest, archiveHash: hashCanonicalValue(archiveWithoutDigest) }
  }

  async restoreArchive(archive: SalesArchive): Promise<ArchiveRestoreResult> {
    const verification = verifySalesArchive(archive)
    if (!verification.valid) {
      throw new Error(`Restauration refusée : ${verification.errors.join(' ')}`)
    }
    await this.ensureInitialized()
    return this.nativeStorage.restoreSnapshot({
      metadata: archive.metadata,
      orders: structuredClone(archive.orders),
      technicalStates: structuredClone(archive.technicalStates),
      entries: structuredClone(archive.entries),
    })
  }

  private async getSnapshot(): Promise<OrderPersistenceSnapshot> {
    await this.ensureInitialized()
    return this.nativeStorage.getSnapshot()
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= this.migrateLegacyIndexedDb()
    return this.initialization
  }

  private async migrateLegacyIndexedDb(): Promise<void> {
    const status = await this.nativeStorage.getLegacyMigrationStatus()
    if (status.completed) return
    if (!this.legacyIndexedDb) {
      throw new Error(
        'Migration vers Room impossible : le stockage IndexedDB historique n’est pas accessible.',
      )
    }

    const legacy = new IndexedDbOrderRepository(this.legacyIndexedDb, this.legacyDatabaseName)
    try {
      const snapshot = await legacy.exportMigrationSnapshot()
      const verification = verifyAuditSnapshot(snapshot)
      if (!verification.valid) {
        throw new Error(`Migration IndexedDB refusée : ${verification.errors.join(' ')}`)
      }
      const result = await this.nativeStorage.importLegacySnapshot(snapshot)
      if (
        result.totalOrders < snapshot.orders.length ||
        result.totalEntries < snapshot.entries.length
      ) {
        throw new Error('La vérification de l’import IndexedDB vers Room a échoué.')
      }
    } finally {
      await legacy.close()
    }
  }
}
