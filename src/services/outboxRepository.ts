import {
  canonicalLedger,
  originalLedgerProfile,
  type LedgerCanonicalization,
} from '../utils/ledgerCanonicalization'
import type { SalesLedgerEntry } from '../types/salesLedger'
import type { ImmutableOrderSnapshot } from '../types/salesLedger'
import { canonicalJson } from '../utils/integrity'
import { indexedDbStores, openSamhainDatabase } from './indexedDbSchema'

export type OutboxStatus =
  'pending' | 'sending' | 'synced' | 'paused_auth' | 'needs_recovery' | 'quarantined'

export type OutboxEntry = {
  eventId: string
  chainId: string
  eventType: 'ledger' | 'legacy_order'
  kind: SalesLedgerEntry['kind'] | 'legacy_order'
  entityId: string
  sourceTerminalId?: string
  sequence: number | null
  hash: string | null
  previousHash: string | null
  payloadCanonical: string
  ledgerCanonicalization: LedgerCanonicalization | null
  organizationId: string | null
  festivalId: string | null
  transportFingerprint: string | null
  status: OutboxStatus
  attemptCount: number
  lastAttemptAt: number | null
  nextAttemptAt: number
  lastError: string | null
  claimOwner: string | null
  leaseExpiresAt: number | null
  receiptId: string | null
  serverReceivedAt: string | null
}

type Identity = { key: 'identity'; chainId: string }
type Backfill = {
  key: 'backfill'
  ledgerCursor: number
  legacyCursor: string
  legacyComplete: boolean
}

function row(chainId: string, entry: SalesLedgerEntry | ImmutableOrderSnapshot): OutboxEntry {
  const ledger = 'kind' in entry ? entry : null
  const profile = ledger ? originalLedgerProfile(ledger) : null
  return {
    eventId: entry.id,
    chainId,
    eventType: ledger ? 'ledger' : 'legacy_order',
    kind: ledger?.kind ?? 'legacy_order',
    entityId: ledger && 'orderId' in ledger ? ledger.orderId : entry.id,
    sourceTerminalId:
      ledger?.source.terminal?.terminalId ??
      ('terminal' in entry ? entry.terminal?.terminalId : undefined),
    sequence: ledger?.sequence ?? null,
    hash: ledger?.hash ?? null,
    previousHash: ledger?.previousHash ?? null,
    payloadCanonical: ledger && profile ? canonicalLedger(entry, profile) : canonicalJson(entry),
    ledgerCanonicalization: profile,
    organizationId: null,
    festivalId: null,
    transportFingerprint: null,
    status: ledger && !profile ? 'quarantined' : 'pending',
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: 0,
    lastError: null,
    claimOwner: null,
    leaseExpiresAt: null,
    receiptId: null,
    serverReceivedAt: null,
  }
}

/** Requests remain inside the caller's read/write transaction, including identity lookup. */
export function captureIndexedDbEvent(
  transaction: IDBTransaction,
  entry: SalesLedgerEntry | ImmutableOrderSnapshot,
): void {
  const request = transaction.objectStore(indexedDbStores.syncMetadata).get('identity')
  request.onsuccess = () => {
    try {
      const identity = request.result as Identity | undefined
      if (!identity) throw new Error('Identité de synchronisation manquante.')
      transaction.objectStore(indexedDbStores.outbox).add(row(identity.chainId, entry))
    } catch {
      transaction.abort()
    }
  }
}

/** Browser preview captures durably; it has no native enrollment and sends no credentials. */
export class IndexedDbOutboxRepository {
  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = 'samhain-pos',
  ) {}

  async entries(): Promise<OutboxEntry[]> {
    const database = await openSamhainDatabase(this.indexedDb, this.databaseName)
    try {
      return await new Promise<OutboxEntry[]>((resolve, reject) => {
        const transaction = database.transaction(indexedDbStores.outbox, 'readonly')
        const request = transaction.objectStore(indexedDbStores.outbox).getAll()
        transaction.oncomplete = () => resolve(request.result as OutboxEntry[])
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
  }

  async backfillBatch(): Promise<boolean> {
    const database = await openSamhainDatabase(this.indexedDb, this.databaseName)
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction(
          [
            indexedDbStores.orders,
            indexedDbStores.salesLedger,
            indexedDbStores.outbox,
            indexedDbStores.syncMetadata,
          ],
          'readwrite',
        )
        const metadata = transaction.objectStore(indexedDbStores.syncMetadata)
        const identityRequest = metadata.get('identity')
        const stateRequest = metadata.get('backfill')
        let complete = false
        stateRequest.onsuccess = () => {
          const identity = identityRequest.result as Identity
          const state: Backfill = (stateRequest.result as Backfill | undefined) ?? {
            key: 'backfill',
            ledgerCursor: 0,
            legacyCursor: '',
            legacyComplete: false,
          }
          let remaining = 100
          let scannedOrders = 0
          const insert = (entry: SalesLedgerEntry | ImmutableOrderSnapshot) => {
            const candidate = row(identity.chainId, entry)
            const outbox = transaction.objectStore(indexedDbStores.outbox)
            const existing = outbox.get(candidate.eventId)
            existing.onsuccess = () => {
              const current = existing.result as OutboxEntry | undefined
              if (!current) outbox.add(candidate)
              else if (
                current.payloadCanonical !== candidate.payloadCanonical ||
                current.chainId !== candidate.chainId
              )
                transaction.abort()
            }
          }
          const orderedLedgerScan = () => {
            const ledger = transaction.objectStore(indexedDbStores.salesLedger)
            const request = ledger
              .index('sequence')
              .openCursor(IDBKeyRange.lowerBound(state.ledgerCursor, true))
            request.onsuccess = () => {
              const cursor = request.result
              if (!cursor || remaining === 0) {
                complete = state.legacyComplete && !cursor
                metadata.put(state)
                return
              }
              const entry = cursor.value as SalesLedgerEntry
              insert(entry)
              state.ledgerCursor = entry.sequence
              remaining--
              cursor.continue()
            }
          }
          if (state.legacyComplete) {
            orderedLedgerScan()
            return
          }
          const legacy = transaction
            .objectStore(indexedDbStores.orders)
            .openCursor(IDBKeyRange.lowerBound(state.legacyCursor, true))
          legacy.onsuccess = () => {
            const cursor = legacy.result
            if (cursor && scannedOrders === 100) {
              metadata.put(state)
              return
            }
            if (!cursor || remaining === 0) {
              if (!cursor) state.legacyComplete = true
              orderedLedgerScan()
              return
            }
            const order = cursor.value as ImmutableOrderSnapshot & {
              integrity?: unknown
              printing?: unknown
            }
            state.legacyCursor = order.id
            scannedOrders++
            if (!order.integrity) {
              const payload = { ...order }
              delete payload.integrity
              delete payload.printing
              insert(payload)
              remaining--
            }
            cursor.continue()
          }
        }
        transaction.oncomplete = () => resolve(complete)
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Rattrapage outbox annulé.'))
      })
    } finally {
      database.close()
    }
  }
}
