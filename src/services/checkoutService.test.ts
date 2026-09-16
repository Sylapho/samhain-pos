import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createValidOrderItems } from '../test/orderFixtures'
import { createLedgerSource } from './ledgerSource'
import { IndexedDbOrderRepository } from './orderRepository'
import { CheckoutService } from './checkoutService'

const terminal = {
  terminalId: 'terminal-a',
  terminalCode: 'A' as const,
  displayName: 'Caisse A',
  provisionedAt: '2026-09-01T09:00:00.000Z',
}

function setup(databaseName: string, id = 'checkout-intent-1') {
  const indexedDb = new IDBFactory()
  const repository = new IndexedDbOrderRepository(indexedDb, databaseName)
  const service = new CheckoutService(
    repository,
    () => id,
    () => terminal,
    createLedgerSource,
  )
  return { indexedDb, repository, service }
}

function setOrderSequence(
  indexedDb: IDBFactory,
  databaseName: string,
  nextOrderSequence: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDb.open(databaseName, 3)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction('metadata', 'readwrite')
      transaction.objectStore('metadata').put({
        key: 'sequences',
        nextOrderSequence,
        nextReceiptSequence: 1,
        nextJournalSequence: 1,
        lastJournalHash: null,
      })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    }
  })
}

describe('frontière durable entre paiement et vente', () => {
  it('crée un snapshot durable sans vente, ledger ni consommation de séquence', async () => {
    const { indexedDb, repository, service } = setup('checkout-create')
    const items = createValidOrderItems()
    const intent = await service.createIntent(
      items,
      'card',
      true,
      new Date('2026-09-01T10:00:00.000Z'),
    )
    items[0]!.quantity = 99

    const snapshot = await repository.exportMigrationSnapshot()
    expect(intent.status).toBe('pending_payment')
    expect(intent.cartSnapshot[0]?.quantity).not.toBe(99)
    expect(snapshot.orders).toEqual([])
    expect(snapshot.entries).toEqual([])
    expect(snapshot.metadata).toMatchObject({
      nextOrderSequence: 1,
      nextReceiptSequence: 1,
      nextJournalSequence: 1,
    })

    const reopened = new CheckoutService(
      new IndexedDbOrderRepository(indexedDb, 'checkout-create'),
      () => 'unused',
      () => terminal,
      createLedgerSource,
    )
    expect((await reopened.getRecoverableIntents())[0]).toMatchObject({
      id: intent.id,
      status: 'pending_payment',
    })
  })

  it('abandonne sans créer de vente ni avancer les séquences', async () => {
    const { repository, service } = setup('checkout-abandon')
    const intent = await service.createIntent(createValidOrderItems(), 'cash')
    await service.beginPayment(intent.id, new Date('2026-09-01T10:01:00.000Z'))
    const abandoned = await service.abandon(intent.id, new Date('2026-09-01T10:02:00.000Z'))
    const snapshot = await repository.exportMigrationSnapshot()

    expect(abandoned.status).toBe('abandoned')
    expect(snapshot.orders).toHaveLength(0)
    expect(snapshot.entries).toHaveLength(0)
    expect(snapshot.metadata).toMatchObject({
      nextOrderSequence: 1,
      nextReceiptSequence: 1,
      nextJournalSequence: 1,
    })
    expect(await service.getRecoverableIntents()).toEqual([])
  })

  it('finalise une seule vente, un seul ledger et une seule fois chaque séquence', async () => {
    const { repository, service } = setup('checkout-finalize')
    const intent = await service.createIntent(
      createValidOrderItems(),
      'card',
      false,
      new Date('2026-09-01T10:00:00.000Z'),
    )
    await service.beginPayment(intent.id, new Date('2026-09-01T10:01:00.000Z'))
    await service.confirmPayment(intent.id, new Date('2026-09-01T10:02:00.000Z'))

    const [first, second] = await Promise.all([
      service.finalize(intent.id, new Date('2026-09-01T10:03:00.000Z')),
      service.finalize(intent.id, new Date('2026-09-01T10:03:01.000Z')),
    ])
    const repeated = await service.finalize(intent.id, new Date('2026-09-01T10:04:00.000Z'))
    const snapshot = await repository.exportMigrationSnapshot()

    expect(first.id).toBe(second.id)
    expect(repeated.id).toBe(first.id)
    expect(first.paymentStatus).toBe('paid')
    expect(first.status).toBe('confirmed')
    expect(first.printing.customerReceipt).toBe('not_requested')
    expect(snapshot.orders).toHaveLength(1)
    expect(snapshot.entries.filter((entry) => entry.kind === 'sale')).toHaveLength(1)
    expect(snapshot.metadata).toMatchObject({
      nextOrderSequence: 2,
      nextReceiptSequence: 2,
      nextJournalSequence: 2,
    })
    expect(await service.getRecoverableIntents()).toEqual([])
  })

  it('conserve un paiement à vérifier après recréation du service sans décision automatique', async () => {
    const { indexedDb, service } = setup('checkout-recovery')
    const intent = await service.createIntent(createValidOrderItems(), 'card')
    await service.beginPayment(intent.id, new Date('2026-09-01T10:01:00.000Z'))

    const restartedRepository = new IndexedDbOrderRepository(indexedDb, 'checkout-recovery')
    const restarted = new CheckoutService(
      restartedRepository,
      () => 'unused',
      () => terminal,
      createLedgerSource,
    )
    const [recovered] = await restarted.getRecoverableIntents()
    const snapshot = await restartedRepository.exportMigrationSnapshot()

    expect(recovered).toMatchObject({ id: intent.id, status: 'payment_to_verify' })
    expect(snapshot.orders).toEqual([])
    expect(snapshot.entries).toEqual([])
  })

  it('refuse une finalisation prématurée sans écriture financière partielle', async () => {
    const { repository, service } = setup('checkout-invalid-finalize')
    const intent = await service.createIntent(createValidOrderItems(), 'cash')
    const before = await repository.exportMigrationSnapshot()

    await expect(service.finalize(intent.id)).rejects.toThrow(/explicitement confirmé/)
    const after = await repository.exportMigrationSnapshot()
    expect(after).toEqual(before)
    expect((await service.getRecoverableIntents())[0]?.status).toBe('pending_payment')
  })

  it('rollback une erreur transactionnelle IndexedDB et permet de retenter', async () => {
    const databaseName = 'checkout-rollback'
    const { indexedDb, repository, service } = setup(databaseName)
    const intent = await service.createIntent(createValidOrderItems(), 'card')
    await service.beginPayment(intent.id, new Date('2026-09-01T10:01:00.000Z'))
    await service.confirmPayment(intent.id, new Date('2026-09-01T10:02:00.000Z'))
    await setOrderSequence(indexedDb, databaseName, Number.MAX_SAFE_INTEGER)

    await expect(service.finalize(intent.id)).rejects.toThrow(/séquences locales/)
    expect((await service.getRecoverableIntents())[0]?.status).toBe('payment_confirmed')

    await setOrderSequence(indexedDb, databaseName, 1)
    const beforeRetry = await repository.exportMigrationSnapshot()
    expect(beforeRetry.orders).toEqual([])
    expect(beforeRetry.entries).toEqual([])
    const order = await service.finalize(intent.id)
    const afterRetry = await repository.exportMigrationSnapshot()
    expect(order.orderNumber).toBe('A-0001')
    expect(afterRetry.orders).toHaveLength(1)
    expect(afterRetry.entries).toHaveLength(1)
  })
})
