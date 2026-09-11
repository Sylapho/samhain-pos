import type { Order, OrderIntegrity, OrderPrinting, PaymentMethod } from '../types/order'
import {
  SALES_ARCHIVE_SCHEMA_VERSION,
  SALES_LEDGER_SCHEMA_VERSION,
  type ArchiveRestoreResult,
  type ClosureLedgerEntry,
  type ClosureRequest,
  type CorrectionLedgerEntry,
  type CorrectionRequest,
  type ImmutableOrderSnapshot,
  type IntegrityVerification,
  type LedgerMetadataSnapshot,
  type LedgerSource,
  type SaleLedgerEntry,
  type SalesArchive,
  type SalesLedgerEntry,
  type StoredOrderTechnicalState,
} from '../types/salesLedger'
import { canonicalJson, hashCanonicalValue } from '../utils/integrity'

const DATABASE_VERSION = 2
const ORDERS_STORE = 'orders'
const ORDER_TECHNICAL_STORE = 'orderTechnicalState'
const SALES_LEDGER_STORE = 'salesLedger'
const METADATA_STORE = 'metadata'
const SEQUENCES_KEY = 'sequences'
const ARCHIVE_NOTICE =
  'Archive JSON Samhain POS. Les montants sont exprimés en centimes. Les entrées sont ordonnées par sequence et chaînées par previousHash/hash en SHA-256. Vérifier archiveHash puis chaque entrée avant consultation ou restauration.'

type StoredSequences = LedgerMetadataSnapshot & { key: typeof SEQUENCES_KEY }

type StoredOrder = ImmutableOrderSnapshot & {
  integrity?: OrderIntegrity
  /** Only present on records created before database version 2. */
  printing?: OrderPrinting
}

type AuditSnapshot = {
  metadata: LedgerMetadataSnapshot
  orders: StoredOrder[]
  technicalStates: StoredOrderTechnicalState[]
  entries: SalesLedgerEntry[]
}

export type AllocatedOrderSequences = { orderSequence: number; receiptSequence: number }

export interface OrderRepository {
  createOrder(
    buildOrder: (sequences: AllocatedOrderSequences) => Order,
    source: LedgerSource,
  ): Promise<Order>
  getOrders(): Promise<Order[]>
  updateOrderPrinting(
    id: string,
    update: (printing: OrderPrinting) => OrderPrinting,
  ): Promise<Order>
}

export interface SalesLedgerRepository {
  recordCorrection(request: CorrectionRequest): Promise<CorrectionLedgerEntry>
  closePeriod(request: ClosureRequest): Promise<ClosureLedgerEntry>
  getLedgerEntries(): Promise<SalesLedgerEntry[]>
  verifyIntegrity(): Promise<IntegrityVerification>
  exportArchive(archiveId: string, exportedAt: string, source: LedgerSource): Promise<SalesArchive>
  restoreArchive(archive: SalesArchive): Promise<ArchiveRestoreResult>
}

function normalizeSequences(stored: StoredSequences | undefined): StoredSequences {
  const normalized: StoredSequences = {
    key: SEQUENCES_KEY,
    nextOrderSequence: stored?.nextOrderSequence ?? 1,
    nextReceiptSequence: stored?.nextReceiptSequence ?? 1,
    nextJournalSequence: stored?.nextJournalSequence ?? 1,
    lastJournalHash: stored?.lastJournalHash ?? null,
    ...(stored?.lastClosureEnd ? { lastClosureEnd: stored.lastClosureEnd } : {}),
  }
  for (const value of [
    normalized.nextOrderSequence,
    normalized.nextReceiptSequence,
    normalized.nextJournalSequence,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Les séquences locales du journal sont invalides.')
    }
  }
  return normalized
}

function metadataSnapshot(metadata: StoredSequences): LedgerMetadataSnapshot {
  return {
    nextOrderSequence: metadata.nextOrderSequence,
    nextReceiptSequence: metadata.nextReceiptSequence,
    nextJournalSequence: metadata.nextJournalSequence,
    lastJournalHash: metadata.lastJournalHash,
    ...(metadata.lastClosureEnd ? { lastClosureEnd: metadata.lastClosureEnd } : {}),
  }
}

function toImmutableOrderSnapshot(order: Order | StoredOrder): ImmutableOrderSnapshot {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    receiptNumber: order.receiptNumber,
    ...(order.terminal ? { terminal: structuredClone(order.terminal) } : {}),
    ...(order.registerName ? { registerName: order.registerName } : {}),
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt,
    items: structuredClone(order.items),
    itemCount: order.itemCount,
    totalCents: order.totalCents,
    createdAt: order.createdAt,
    status: order.status,
  }
}

function toStoredOrder(order: Order, integrity: OrderIntegrity): StoredOrder {
  return { ...toImmutableOrderSnapshot(order), integrity }
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

function toOrder(stored: StoredOrder, technical?: StoredOrderTechnicalState): Order {
  return {
    ...toImmutableOrderSnapshot(stored),
    ...(stored.integrity ? { integrity: structuredClone(stored.integrity) } : {}),
    printing: structuredClone(
      technical?.printing ?? stored.printing ?? unknownPrinting(stored.createdAt),
    ),
  }
}

function hashLedgerEntry(entry: Omit<SalesLedgerEntry, 'hash'>): string {
  return hashCanonicalValue(entry)
}

function entryWithoutHash(entry: SalesLedgerEntry): Omit<SalesLedgerEntry, 'hash'> {
  const copy = { ...entry } as Partial<SalesLedgerEntry>
  delete copy.hash
  return copy as Omit<SalesLedgerEntry, 'hash'>
}

function archiveWithoutHash(archive: SalesArchive): Omit<SalesArchive, 'archiveHash'> {
  const copy = { ...archive } as Partial<SalesArchive>
  delete copy.archiveHash
  return copy as Omit<SalesArchive, 'archiveHash'>
}

function appendEntryMetadata(metadata: StoredSequences, entry: SalesLedgerEntry): StoredSequences {
  return { ...metadata, nextJournalSequence: entry.sequence + 1, lastJournalHash: entry.hash }
}

function requestFailure(request: IDBRequest, fallback: string): Error {
  return request.error ?? new Error(fallback)
}

function compareCorrectionRequest(
  entry: CorrectionLedgerEntry,
  request: CorrectionRequest,
): boolean {
  return (
    entry.correction.operationId === request.operationId &&
    entry.correction.originalOrderId === request.originalOrderId &&
    entry.correction.type === request.type &&
    entry.correction.reason === request.reason &&
    entry.correction.amountDeltaCents === request.amountDeltaCents
  )
}

function compareClosureRequest(entry: ClosureLedgerEntry, request: ClosureRequest): boolean {
  return (
    entry.closure.operationId === request.operationId &&
    entry.closure.periodStart === request.periodStart &&
    entry.closure.periodEnd === request.periodEnd
  )
}

function calculateClosureTotals(
  entries: SalesLedgerEntry[],
  periodStart: string,
  periodEnd: string,
): ClosureLedgerEntry['closure']['totals'] {
  let saleCount = 0
  let grossSalesCents = 0
  let correctionCount = 0
  let correctionTotalCents = 0
  const paymentTotalsCents: Record<PaymentMethod, number> = { cash: 0, card: 0 }
  let cumulativeNetTotalCents = 0

  for (const entry of entries) {
    if (entry.kind === 'sale' && entry.order.paidAt < periodEnd) {
      cumulativeNetTotalCents += entry.order.totalCents
    }
    if (entry.kind === 'correction' && entry.recordedAt < periodEnd) {
      cumulativeNetTotalCents += entry.correction.amountDeltaCents
    }
    if (
      entry.kind === 'sale' &&
      entry.order.paidAt >= periodStart &&
      entry.order.paidAt < periodEnd
    ) {
      saleCount += 1
      grossSalesCents += entry.order.totalCents
      paymentTotalsCents[entry.order.paymentMethod] += entry.order.totalCents
    }
    if (
      entry.kind === 'correction' &&
      entry.recordedAt >= periodStart &&
      entry.recordedAt < periodEnd
    ) {
      correctionCount += 1
      correctionTotalCents += entry.correction.amountDeltaCents
      paymentTotalsCents[entry.correction.paymentMethod] += entry.correction.amountDeltaCents
    }
  }

  return {
    saleCount,
    grossSalesCents,
    correctionCount,
    correctionTotalCents,
    netTotalCents: grossSalesCents + correctionTotalCents,
    cumulativeNetTotalCents,
    paymentTotalsCents,
  }
}

function verifyAuditSnapshot(snapshot: AuditSnapshot): IntegrityVerification {
  const errors: string[] = []
  const warnings: string[] = []
  const entries = [...snapshot.entries].sort((left, right) => left.sequence - right.sequence)
  let previousHash: string | null = null

  entries.forEach((entry, index) => {
    const expectedSequence = index + 1
    if (entry.sequence !== expectedSequence) {
      errors.push(`Séquence de journal attendue ${expectedSequence}, trouvée ${entry.sequence}.`)
    }
    if (entry.previousHash !== previousHash)
      errors.push(`Chaînage invalide à l’entrée ${entry.id}.`)
    if (entry.schemaVersion !== SALES_LEDGER_SCHEMA_VERSION) {
      errors.push(`Version de journal non prise en charge à l’entrée ${entry.id}.`)
    }
    if (hashLedgerEntry(entryWithoutHash(entry)) !== entry.hash) {
      errors.push(`Empreinte invalide à l’entrée ${entry.id}.`)
    }
    previousHash = entry.hash
  })

  const sealedOrders = new Map<string, SaleLedgerEntry>()
  for (const entry of entries) {
    if (entry.kind === 'sale') {
      if (sealedOrders.has(entry.orderId))
        errors.push(`Vente ${entry.orderId} journalisée plusieurs fois.`)
      sealedOrders.set(entry.orderId, entry)
    }
    if (entry.kind === 'correction') {
      const original = snapshot.orders.find(
        (order) => order.id === entry.correction.originalOrderId,
      )
      if (!original) errors.push(`Vente d’origine ${entry.correction.originalOrderId} introuvable.`)
      if (original?.integrity && entry.correction.originalSaleHash !== original.integrity.hash) {
        errors.push(`Référence d’intégrité invalide pour la correction ${entry.id}.`)
      }
    }
    if (entry.kind === 'closure') {
      const precedingEntries = entries.filter((candidate) => candidate.sequence < entry.sequence)
      const expectedTotals = calculateClosureTotals(
        precedingEntries,
        entry.closure.periodStart,
        entry.closure.periodEnd,
      )
      if (canonicalJson(expectedTotals) !== canonicalJson(entry.closure.totals)) {
        errors.push(`Totaux de clôture invalides à l’entrée ${entry.id}.`)
      }
    }
  }

  const legacyOrderIds: string[] = []
  for (const order of snapshot.orders) {
    const saleEntry = sealedOrders.get(order.id)
    if (!order.integrity) {
      legacyOrderIds.push(order.id)
      continue
    }
    if (!saleEntry) {
      errors.push(`Entrée de vente absente pour la commande ${order.id}.`)
      continue
    }
    if (
      order.integrity.algorithm !== 'SHA-256' ||
      order.integrity.journalEntryId !== saleEntry.id ||
      order.integrity.journalSequence !== saleEntry.sequence ||
      order.integrity.hash !== saleEntry.hash
    ) {
      errors.push(`Référence de journal invalide pour la commande ${order.id}.`)
    }
    if (canonicalJson(toImmutableOrderSnapshot(order)) !== canonicalJson(saleEntry.order)) {
      errors.push(`Données financières altérées pour la commande ${order.id}.`)
    }
  }
  for (const orderId of sealedOrders.keys()) {
    if (!snapshot.orders.some((order) => order.id === orderId)) {
      errors.push(`Commande ${orderId} absente alors que sa vente est journalisée.`)
    }
  }

  if (legacyOrderIds.length > 0) {
    warnings.push(
      `${legacyOrderIds.length} commande(s) antérieure(s) au journal ne peuvent pas être scellées rétroactivement.`,
    )
  }
  if (snapshot.metadata.nextJournalSequence !== entries.length + 1) {
    errors.push('La prochaine séquence du journal ne correspond pas à son contenu.')
  }
  if (snapshot.metadata.lastJournalHash !== previousHash) {
    errors.push('L’empreinte de tête du journal ne correspond pas à sa dernière entrée.')
  }
  const lastClosure = entries
    .filter((entry): entry is ClosureLedgerEntry => entry.kind === 'closure')
    .at(-1)
  if (snapshot.metadata.lastClosureEnd !== lastClosure?.closure.periodEnd) {
    errors.push('La fin de période clôturée ne correspond pas au journal.')
  }

  return {
    valid: errors.length === 0,
    complete: errors.length === 0 && legacyOrderIds.length === 0,
    entryCount: entries.length,
    sealedOrderCount: sealedOrders.size,
    legacyOrderIds,
    errors,
    warnings,
    headHash: previousHash,
  }
}

export function verifySalesArchive(archive: SalesArchive): IntegrityVerification {
  const verification = verifyAuditSnapshot({
    metadata: archive.metadata,
    orders: archive.orders,
    technicalStates: archive.technicalStates,
    entries: archive.entries,
  })
  if (archive.schemaVersion !== SALES_ARCHIVE_SCHEMA_VERSION) {
    verification.errors.push(`Version d’archive ${archive.schemaVersion} non prise en charge.`)
  }
  if (hashCanonicalValue(archiveWithoutHash(archive)) !== archive.archiveHash) {
    verification.errors.push('Empreinte globale de l’archive invalide.')
  }
  verification.valid = verification.errors.length === 0
  verification.complete = verification.valid && verification.legacyOrderIds.length === 0
  return verification
}

export class IndexedDbOrderRepository implements OrderRepository, SalesLedgerRepository {
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = 'samhain-pos',
  ) {}

  createOrder(
    buildOrder: (sequences: AllocatedOrderSequences) => Order,
    source: LedgerSource,
  ): Promise<Order> {
    return this.openDatabase().then(
      (database) =>
        new Promise<Order>((resolve, reject) => {
          const transaction = database.transaction(
            [ORDERS_STORE, ORDER_TECHNICAL_STORE, SALES_LEDGER_STORE, METADATA_STORE],
            'readwrite',
          )
          const orders = transaction.objectStore(ORDERS_STORE)
          const technicalStates = transaction.objectStore(ORDER_TECHNICAL_STORE)
          const ledger = transaction.objectStore(SALES_LEDGER_STORE)
          const metadataStore = transaction.objectStore(METADATA_STORE)
          const sequenceRequest = metadataStore.get(SEQUENCES_KEY)
          let createdOrder: Order | null = null
          let operationError: unknown

          sequenceRequest.onsuccess = () => {
            try {
              let metadata = normalizeSequences(
                sequenceRequest.result as StoredSequences | undefined,
              )
              const sequences: AllocatedOrderSequences = {
                orderSequence: metadata.nextOrderSequence,
                receiptSequence: metadata.nextReceiptSequence,
              }
              const order = buildOrder(sequences)
              if (metadata.lastClosureEnd && order.paidAt < metadata.lastClosureEnd) {
                throw new Error(
                  'Impossible d’enregistrer une vente dans une période déjà clôturée.',
                )
              }
              const entryWithoutDigest: Omit<SaleLedgerEntry, 'hash'> = {
                schemaVersion: SALES_LEDGER_SCHEMA_VERSION,
                id: `sale:${order.id}`,
                sequence: metadata.nextJournalSequence,
                kind: 'sale',
                recordedAt: order.createdAt,
                previousHash: metadata.lastJournalHash,
                source: structuredClone(source),
                orderId: order.id,
                order: toImmutableOrderSnapshot(order),
              }
              const entry: SaleLedgerEntry = {
                ...entryWithoutDigest,
                hash: hashLedgerEntry(entryWithoutDigest),
              }
              const integrity: OrderIntegrity = {
                algorithm: 'SHA-256',
                journalEntryId: entry.id,
                journalSequence: entry.sequence,
                hash: entry.hash,
              }
              const storedOrder = toStoredOrder(order, integrity)
              createdOrder = toOrder(storedOrder, { orderId: order.id, printing: order.printing })
              metadata = {
                ...appendEntryMetadata(metadata, entry),
                nextOrderSequence: sequences.orderSequence + 1,
                nextReceiptSequence: sequences.receiptSequence + 1,
              }

              orders.add(storedOrder)
              technicalStates.add({
                orderId: order.id,
                printing: order.printing,
              } satisfies StoredOrderTechnicalState)
              ledger.add(entry)
              metadataStore.put(metadata)
            } catch (error) {
              operationError = error
              transaction.abort()
            }
          }
          sequenceRequest.onerror = () => {
            operationError = requestFailure(sequenceRequest, 'Échec de la séquence locale.')
          }
          transaction.oncomplete = () => {
            if (createdOrder) resolve(createdOrder)
            else reject(new Error('La commande locale n’a pas été créée.'))
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Transaction locale annulée.'))
        }),
    )
  }

  async getOrders(): Promise<Order[]> {
    const snapshot = await this.readAuditSnapshot()
    const technicalByOrder = new Map(
      snapshot.technicalStates.map((technical) => [technical.orderId, technical]),
    )
    return snapshot.orders.map((order) => toOrder(order, technicalByOrder.get(order.id)))
  }

  updateOrderPrinting(
    id: string,
    update: (printing: OrderPrinting) => OrderPrinting,
  ): Promise<Order> {
    return this.openDatabase().then(
      (database) =>
        new Promise<Order>((resolve, reject) => {
          const transaction = database.transaction(
            [ORDERS_STORE, ORDER_TECHNICAL_STORE],
            'readwrite',
          )
          const orders = transaction.objectStore(ORDERS_STORE)
          const technicalStates = transaction.objectStore(ORDER_TECHNICAL_STORE)
          const orderRequest = orders.get(id)
          let updatedOrder: Order | null = null
          let operationError: unknown

          orderRequest.onsuccess = () => {
            if (!orderRequest.result) {
              operationError = new Error(`Commande locale ${id} introuvable.`)
              transaction.abort()
              return
            }
            const storedOrder = orderRequest.result as StoredOrder
            const technicalRequest = technicalStates.get(id)
            technicalRequest.onsuccess = () => {
              try {
                const technical = technicalRequest.result as StoredOrderTechnicalState | undefined
                const current =
                  technical?.printing ??
                  storedOrder.printing ??
                  unknownPrinting(storedOrder.createdAt)
                const printing = update(structuredClone(current))
                technicalStates.put({ orderId: id, printing } satisfies StoredOrderTechnicalState)
                updatedOrder = toOrder(storedOrder, { orderId: id, printing })
              } catch (error) {
                operationError = error
                transaction.abort()
              }
            }
            technicalRequest.onerror = () => {
              operationError = requestFailure(
                technicalRequest,
                'Lecture de l’état technique impossible.',
              )
            }
          }
          orderRequest.onerror = () => {
            operationError = requestFailure(orderRequest, 'Lecture de la commande impossible.')
          }
          transaction.oncomplete = () => {
            if (updatedOrder) resolve(updatedOrder)
            else reject(new Error('L’état d’impression n’a pas été mis à jour.'))
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Transaction locale annulée.'))
        }),
    )
  }

  recordCorrection(request: CorrectionRequest): Promise<CorrectionLedgerEntry> {
    return this.openDatabase().then(
      (database) =>
        new Promise<CorrectionLedgerEntry>((resolve, reject) => {
          const transaction = database.transaction(
            [ORDERS_STORE, SALES_LEDGER_STORE, METADATA_STORE],
            'readwrite',
          )
          const orders = transaction.objectStore(ORDERS_STORE)
          const ledger = transaction.objectStore(SALES_LEDGER_STORE)
          const metadataStore = transaction.objectStore(METADATA_STORE)
          const orderRequest = orders.get(request.originalOrderId)
          let result: CorrectionLedgerEntry | null = null
          let operationError: unknown

          orderRequest.onsuccess = () => {
            if (!orderRequest.result) {
              operationError = new Error(`Commande locale ${request.originalOrderId} introuvable.`)
              transaction.abort()
              return
            }
            const storedOrder = orderRequest.result as StoredOrder
            const entriesRequest = ledger.getAll()
            entriesRequest.onsuccess = () => {
              const entries = entriesRequest.result as SalesLedgerEntry[]
              const existing = entries.find(
                (entry) => entry.id === `correction:${request.operationId}`,
              )
              if (existing) {
                if (
                  existing.kind !== 'correction' ||
                  !compareCorrectionRequest(existing, request)
                ) {
                  operationError = new Error(
                    'Cette clé d’opération appartient déjà à une autre correction.',
                  )
                  transaction.abort()
                } else result = existing
                return
              }
              const metadataRequest = metadataStore.get(SEQUENCES_KEY)
              metadataRequest.onsuccess = () => {
                try {
                  let metadata = normalizeSequences(
                    metadataRequest.result as StoredSequences | undefined,
                  )
                  if (metadata.lastClosureEnd && request.recordedAt < metadata.lastClosureEnd) {
                    throw new Error('Impossible de corriger une période déjà clôturée.')
                  }
                  this.validateCorrection(request, storedOrder, entries)
                  const entryWithoutDigest: Omit<CorrectionLedgerEntry, 'hash'> = {
                    schemaVersion: SALES_LEDGER_SCHEMA_VERSION,
                    id: `correction:${request.operationId}`,
                    sequence: metadata.nextJournalSequence,
                    kind: 'correction',
                    recordedAt: request.recordedAt,
                    previousHash: metadata.lastJournalHash,
                    source: structuredClone(request.source),
                    correction: {
                      operationId: request.operationId,
                      originalOrderId: storedOrder.id,
                      originalOrderNumber: storedOrder.orderNumber,
                      originalReceiptNumber: storedOrder.receiptNumber,
                      type: request.type,
                      reason: request.reason,
                      amountDeltaCents: request.amountDeltaCents,
                      paymentMethod: storedOrder.paymentMethod,
                      originalSaleHash: storedOrder.integrity?.hash ?? null,
                    },
                  }
                  const entry: CorrectionLedgerEntry = {
                    ...entryWithoutDigest,
                    hash: hashLedgerEntry(entryWithoutDigest),
                  }
                  ledger.add(entry)
                  metadata = appendEntryMetadata(metadata, entry)
                  metadataStore.put(metadata)
                  result = entry
                } catch (error) {
                  operationError = error
                  transaction.abort()
                }
              }
              metadataRequest.onerror = () => {
                operationError = requestFailure(metadataRequest, 'Lecture du journal impossible.')
              }
            }
            entriesRequest.onerror = () => {
              operationError = requestFailure(entriesRequest, 'Lecture du journal impossible.')
            }
          }
          orderRequest.onerror = () => {
            operationError = requestFailure(orderRequest, 'Lecture de la commande impossible.')
          }
          transaction.oncomplete = () => {
            if (result) resolve(result)
            else reject(new Error('La correction n’a pas été enregistrée.'))
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Transaction locale annulée.'))
        }),
    )
  }

  closePeriod(request: ClosureRequest): Promise<ClosureLedgerEntry> {
    return this.openDatabase().then(
      (database) =>
        new Promise<ClosureLedgerEntry>((resolve, reject) => {
          const transaction = database.transaction(
            [SALES_LEDGER_STORE, METADATA_STORE],
            'readwrite',
          )
          const ledger = transaction.objectStore(SALES_LEDGER_STORE)
          const metadataStore = transaction.objectStore(METADATA_STORE)
          const entriesRequest = ledger.getAll()
          let result: ClosureLedgerEntry | null = null
          let operationError: unknown

          entriesRequest.onsuccess = () => {
            const entries = entriesRequest.result as SalesLedgerEntry[]
            const existing = entries.find((entry) => entry.id === `closure:${request.operationId}`)
            if (existing) {
              if (existing.kind !== 'closure' || !compareClosureRequest(existing, request)) {
                operationError = new Error(
                  'Cette clé d’opération appartient déjà à une autre clôture.',
                )
                transaction.abort()
              } else result = existing
              return
            }
            const metadataRequest = metadataStore.get(SEQUENCES_KEY)
            metadataRequest.onsuccess = () => {
              try {
                let metadata = normalizeSequences(
                  metadataRequest.result as StoredSequences | undefined,
                )
                if (request.periodStart >= request.periodEnd) {
                  throw new Error('La fin de période doit être postérieure à son début.')
                }
                if (request.periodEnd > request.recordedAt) {
                  throw new Error('Une période future ne peut pas être clôturée.')
                }
                if (metadata.lastClosureEnd && request.periodStart !== metadata.lastClosureEnd) {
                  throw new Error('La nouvelle clôture doit commencer à la fin de la précédente.')
                }
                const entryWithoutDigest: Omit<ClosureLedgerEntry, 'hash'> = {
                  schemaVersion: SALES_LEDGER_SCHEMA_VERSION,
                  id: `closure:${request.operationId}`,
                  sequence: metadata.nextJournalSequence,
                  kind: 'closure',
                  recordedAt: request.recordedAt,
                  previousHash: metadata.lastJournalHash,
                  source: structuredClone(request.source),
                  closure: {
                    operationId: request.operationId,
                    periodStart: request.periodStart,
                    periodEnd: request.periodEnd,
                    totals: calculateClosureTotals(entries, request.periodStart, request.periodEnd),
                  },
                }
                const entry: ClosureLedgerEntry = {
                  ...entryWithoutDigest,
                  hash: hashLedgerEntry(entryWithoutDigest),
                }
                ledger.add(entry)
                metadata = {
                  ...appendEntryMetadata(metadata, entry),
                  lastClosureEnd: request.periodEnd,
                }
                metadataStore.put(metadata)
                result = entry
              } catch (error) {
                operationError = error
                transaction.abort()
              }
            }
            metadataRequest.onerror = () => {
              operationError = requestFailure(metadataRequest, 'Lecture du journal impossible.')
            }
          }
          entriesRequest.onerror = () => {
            operationError = requestFailure(entriesRequest, 'Lecture du journal impossible.')
          }
          transaction.oncomplete = () => {
            if (result) resolve(result)
            else reject(new Error('La clôture n’a pas été enregistrée.'))
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Transaction locale annulée.'))
        }),
    )
  }

  async getLedgerEntries(): Promise<SalesLedgerEntry[]> {
    const snapshot = await this.readAuditSnapshot()
    return snapshot.entries.sort((left, right) => left.sequence - right.sequence)
  }

  async verifyIntegrity(): Promise<IntegrityVerification> {
    return verifyAuditSnapshot(await this.readAuditSnapshot())
  }

  async exportArchive(
    archiveId: string,
    exportedAt: string,
    source: LedgerSource,
  ): Promise<SalesArchive> {
    const snapshot = await this.readAuditSnapshot()
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
    if (!verification.valid)
      throw new Error(`Restauration refusée : ${verification.errors.join(' ')}`)
    const database = await this.openDatabase()
    return new Promise<ArchiveRestoreResult>((resolve, reject) => {
      const transaction = database.transaction(
        [ORDERS_STORE, ORDER_TECHNICAL_STORE, SALES_LEDGER_STORE, METADATA_STORE],
        'readwrite',
      )
      const orders = transaction.objectStore(ORDERS_STORE)
      const technicalStates = transaction.objectStore(ORDER_TECHNICAL_STORE)
      const ledger = transaction.objectStore(SALES_LEDGER_STORE)
      const metadataStore = transaction.objectStore(METADATA_STORE)
      const orderCount = orders.count()
      let operationError: unknown

      orderCount.onsuccess = () => {
        const ledgerCount = ledger.count()
        ledgerCount.onsuccess = () => {
          if (orderCount.result !== 0 || ledgerCount.result !== 0) {
            operationError = new Error('La restauration exige une base locale vide.')
            transaction.abort()
            return
          }
          try {
            for (const order of archive.orders) orders.add(structuredClone(order))
            for (const technical of archive.technicalStates)
              technicalStates.add(structuredClone(technical))
            for (const entry of archive.entries) ledger.add(structuredClone(entry))
            metadataStore.put({ key: SEQUENCES_KEY, ...archive.metadata } satisfies StoredSequences)
          } catch (error) {
            operationError = error
            transaction.abort()
          }
        }
        ledgerCount.onerror = () => {
          operationError = requestFailure(ledgerCount, 'Lecture du journal impossible.')
        }
      }
      orderCount.onerror = () => {
        operationError = requestFailure(orderCount, 'Lecture des commandes impossible.')
      }
      transaction.oncomplete = () =>
        resolve({ restoredOrders: archive.orders.length, restoredEntries: archive.entries.length })
      transaction.onerror = () => {
        operationError ??= transaction.error ?? new Error('Échec de la restauration locale.')
      }
      transaction.onabort = () =>
        reject(operationError ?? transaction.error ?? new Error('Restauration locale annulée.'))
    })
  }

  async close(): Promise<void> {
    if (!this.databasePromise) return
    const database = await this.databasePromise
    database.close()
    this.databasePromise = null
  }

  private validateCorrection(
    request: CorrectionRequest,
    order: StoredOrder,
    entries: SalesLedgerEntry[],
  ): void {
    if (!request.operationId.trim())
      throw new Error('La clé d’opération de correction est requise.')
    if (!request.reason.trim()) throw new Error('Le motif de correction est requis.')
    if (
      !Number.isSafeInteger(request.amountDeltaCents) ||
      (request.type !== 'cancellation' && request.amountDeltaCents === 0)
    ) {
      throw new Error('Le montant de correction doit être un entier valide en centimes.')
    }
    if (['cancellation', 'refund'].includes(request.type) && request.amountDeltaCents >= 0) {
      throw new Error('Une annulation ou un remboursement doit diminuer le total encaissé.')
    }
    if (request.type === 'cancellation' && request.amountDeltaCents !== -order.totalCents) {
      throw new Error('Une annulation doit compenser exactement le total de la vente.')
    }

    const priorCorrections = entries.filter(
      (entry): entry is CorrectionLedgerEntry =>
        entry.kind === 'correction' && entry.correction.originalOrderId === order.id,
    )
    if (priorCorrections.some((entry) => entry.correction.type === 'cancellation')) {
      throw new Error('Cette vente a déjà été annulée.')
    }
    if (request.type === 'cancellation' && priorCorrections.length > 0) {
      throw new Error('Une vente partiellement corrigée ne peut pas être annulée intégralement.')
    }
    if (request.type === 'refund') {
      const alreadyRefunded = priorCorrections
        .filter((entry) => entry.correction.type === 'refund')
        .reduce((sum, entry) => sum - entry.correction.amountDeltaCents, 0)
      if (alreadyRefunded - request.amountDeltaCents > order.totalCents) {
        throw new Error('Le cumul des remboursements dépasse le total de la vente.')
      }
    }
  }

  private readAuditSnapshot(): Promise<AuditSnapshot> {
    return this.openDatabase().then(
      (database) =>
        new Promise<AuditSnapshot>((resolve, reject) => {
          const transaction = database.transaction(
            [ORDERS_STORE, ORDER_TECHNICAL_STORE, SALES_LEDGER_STORE, METADATA_STORE],
            'readonly',
          )
          const orderRequest = transaction.objectStore(ORDERS_STORE).getAll()
          const technicalRequest = transaction.objectStore(ORDER_TECHNICAL_STORE).getAll()
          const ledgerRequest = transaction.objectStore(SALES_LEDGER_STORE).getAll()
          const metadataRequest = transaction.objectStore(METADATA_STORE).get(SEQUENCES_KEY)
          let operationError: unknown

          for (const [request, message] of [
            [orderRequest, 'Lecture des commandes locales impossible.'],
            [technicalRequest, 'Lecture des états techniques impossible.'],
            [ledgerRequest, 'Lecture du journal impossible.'],
            [metadataRequest, 'Lecture des séquences impossible.'],
          ] as const) {
            request.onerror = () => {
              operationError = requestFailure(request, message)
            }
          }
          transaction.oncomplete = () => {
            try {
              const metadata = normalizeSequences(
                metadataRequest.result as StoredSequences | undefined,
              )
              resolve({
                metadata: metadataSnapshot(metadata),
                orders: orderRequest.result as StoredOrder[],
                technicalStates: technicalRequest.result as StoredOrderTechnicalState[],
                entries: ledgerRequest.result as SalesLedgerEntry[],
              })
            } catch (error) {
              reject(error)
            }
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Lecture locale impossible.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Lecture locale annulée.'))
        }),
    )
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(ORDERS_STORE)) {
          database.createObjectStore(ORDERS_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'key' })
        }
        if (!database.objectStoreNames.contains(ORDER_TECHNICAL_STORE)) {
          database.createObjectStore(ORDER_TECHNICAL_STORE, { keyPath: 'orderId' })
        }
        if (!database.objectStoreNames.contains(SALES_LEDGER_STORE)) {
          database.createObjectStore(SALES_LEDGER_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => {
        this.databasePromise = null
        reject(request.error ?? new Error('Ouverture du stockage local impossible.'))
      }
      request.onblocked = () => {
        this.databasePromise = null
        reject(new Error('Mise à niveau du stockage bloquée par un autre onglet ouvert.'))
      }
    })
    return this.databasePromise
  }
}
