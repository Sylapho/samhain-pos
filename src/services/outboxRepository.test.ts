import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeAll, describe, expect, it } from 'vitest'
import { createValidOrderItems } from '../test/orderFixtures'
import { canonicalJson } from '../utils/integrity'
import { CashSessionService } from './cashSessionService'
import { CheckoutService } from './checkoutService'
import { createLedgerSource } from './ledgerSource'
import { openSamhainDatabase, indexedDbStores } from './indexedDbSchema'
import { IndexedDbOrderRepository } from './orderRepository'
import { toImmutableOrderSnapshot } from './orderRepository'
import { OrderService } from './orderService'
import { IndexedDbOutboxRepository } from './outboxRepository'
import { SalesLedgerService } from './salesLedgerService'

beforeAll(() => {
  globalThis.IDBKeyRange = IDBKeyRange
})
const terminal = {
  terminalId: 'terminal-a',
  terminalCode: 'A' as const,
  displayName: 'Caisse A',
  provisionedAt: '2026-09-01T08:00:00.000Z',
}
function setup() {
  const factory = new IDBFactory()
  const name = crypto.randomUUID()
  const repository = new IndexedDbOrderRepository(factory, name)
  const outbox = new IndexedDbOutboxRepository(factory, name)
  let id = 0
  const next = () => `operation-${++id}`
  return {
    factory,
    name,
    repository,
    outbox,
    orders: new OrderService(repository, next, () => terminal),
    checkout: new CheckoutService(repository, next, () => terminal, createLedgerSource),
    sessions: new CashSessionService(
      repository,
      next,
      () => terminal,
      undefined,
      () => {},
    ),
    ledger: new SalesLedgerService(
      repository,
      next,
      () => terminal,
      undefined,
      () => {},
    ),
  }
}
async function mutate(factory: IDBFactory, name: string, operation: (tx: IDBTransaction) => void) {
  const db = await openSamhainDatabase(factory, name)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([indexedDbStores.outbox, indexedDbStores.syncMetadata], 'readwrite')
      operation(tx)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('outbox transactionnelle IndexedDB', () => {
  it('migre la version 4 et rattrape une vente legacy sans inventer de scellement', async () => {
    const source = setup()
    const sale = await source.orders.createOrder(createValidOrderItems(), 'cash')
    const legacy = { ...toImmutableOrderSnapshot(sale), id: 'legacy-order' }
    await source.repository.close()
    const factory = new IDBFactory()
    const name = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(name, 4)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore(indexedDbStores.orders, { keyPath: 'id' }).add({
          ...legacy,
          printing: sale.printing,
        })
        db.createObjectStore(indexedDbStores.metadata, { keyPath: 'key' })
        db.createObjectStore(indexedDbStores.salesLedger, { keyPath: 'id' })
      }
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
    const outbox = new IndexedDbOutboxRepository(factory, name)
    expect(await outbox.backfillBatch()).toBe(true)
    const rows = await outbox.entries()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventId: 'legacy-order',
      eventType: 'legacy_order',
      sequence: null,
      hash: null,
      ledgerCanonicalization: null,
    })
    expect(rows[0]?.payloadCanonical).toBe(canonicalJson(legacy))
    expect(await outbox.backfillBatch()).toBe(true)
    expect(await outbox.entries()).toEqual(rows)
  })
  it('capture les cinq kinds sans configuration réseau et conserve payloads et impressions', async () => {
    const s = setup()
    await s.sessions.openSession(0, new Date('2026-09-01T09:00:00Z'))
    await s.sessions.updateOpeningFloat(100, new Date('2026-09-01T09:30:00Z'))
    const sale = await s.orders.createOrder(
      createValidOrderItems(),
      'cash',
      new Date('2026-09-01T10:00:00Z'),
    )
    await s.ledger.cancelSale(sale.id, 'test', undefined, new Date('2026-09-01T11:00:00Z'))
    await s.ledger.closePeriod(
      new Date('2026-09-01T09:00:00Z'),
      new Date('2026-09-01T18:00:00Z'),
      undefined,
      new Date('2026-09-01T18:01:00Z'),
    )
    const entries = await s.ledger.getEntries()
    const rows = await s.outbox.entries()
    expect(new Set(rows.map((row) => row.kind))).toEqual(
      new Set(['sale', 'correction', 'closure', 'cash_session_opened', 'cash_float_updated']),
    )
    for (const entry of entries) {
      expect(rows.find((row) => row.eventId === entry.id)).toMatchObject({
        sequence: entry.sequence,
        hash: entry.hash,
        previousHash: entry.previousHash,
        payloadCanonical: canonicalJson(entry),
        status: 'pending',
        transportFingerprint: null,
      })
    }
    expect((await s.orders.getOrders())[0]?.printing).toEqual(sale.printing)
    await s.repository.close()
    expect(await new IndexedDbOutboxRepository(s.factory, s.name).entries()).toEqual(rows)
  })
  it('double finalisation garde une vente, un paiement, une séquence et une entrée', async () => {
    const s = setup()
    const intent = await s.checkout.createIntent(createValidOrderItems(), 'card', true)
    await s.checkout.beginPayment(intent.id)
    await s.checkout.confirmPayment(intent.id)
    const [first, second] = await Promise.all([
      s.checkout.finalize(intent.id),
      s.checkout.finalize(intent.id),
    ])
    expect(second).toEqual(first)
    expect(await s.outbox.entries()).toHaveLength(1)
    expect((await s.repository.exportMigrationSnapshot()).metadata.nextJournalSequence).toBe(2)
    await s.repository.close()
  })
  it('une erreur outbox annule vente, intention finalisée et toutes les séquences', async () => {
    const s = setup()
    const intent = await s.checkout.createIntent(createValidOrderItems(), 'cash')
    await s.checkout.beginPayment(intent.id)
    await s.checkout.confirmPayment(intent.id)
    await mutate(s.factory, s.name, (tx) =>
      tx.objectStore(indexedDbStores.outbox).add({ eventId: `sale:${intent.id}` }),
    )
    const before = await s.repository.exportMigrationSnapshot()
    await expect(s.checkout.finalize(intent.id)).rejects.toBeDefined()
    expect(await s.repository.exportMigrationSnapshot()).toEqual(before)
    expect((await s.repository.getCheckoutIntents())[0]?.status).toBe('payment_confirmed')
    await s.repository.close()
  })
  it('backfill borné reprend le curseur sans modifier le journal et accepte une vente concurrente', async () => {
    const s = setup()
    for (let n = 0; n < 205; n++) await s.orders.createOrder(createValidOrderItems(), 'cash')
    const before = await s.repository.exportMigrationSnapshot()
    await mutate(s.factory, s.name, (tx) => {
      tx.objectStore(indexedDbStores.outbox).clear()
      tx.objectStore(indexedDbStores.syncMetadata).delete('backfill')
    })
    expect(await s.outbox.backfillBatch()).toBe(false)
    expect((await s.outbox.entries()).length).toBeLessThanOrEqual(100)
    await s.orders.createOrder(createValidOrderItems(), 'card')
    const restarted = new IndexedDbOutboxRepository(s.factory, s.name)
    let previous = (await restarted.entries()).length
    while (!(await restarted.backfillBatch())) {
      const current = (await restarted.entries()).length
      expect(current - previous).toBeLessThanOrEqual(100)
      previous = current
    }
    expect(await restarted.entries()).toHaveLength(206)
    expect(await restarted.backfillBatch()).toBe(true)
    const after = await s.repository.exportMigrationSnapshot()
    expect(after.entries.filter((entry) => entry.sequence <= 205)).toEqual(before.entries)
    expect(
      after.technicalStates.filter((state) =>
        before.technicalStates.some((old) => old.orderId === state.orderId),
      ),
    ).toEqual(before.technicalStates)
    await s.repository.close()
  })
})
