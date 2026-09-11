import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { products } from '../mocks/products'
import type { SalesArchive } from '../types/salesLedger'
import type { TerminalConfiguration } from '../types/terminal'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'
import { SalesLedgerService } from './salesLedgerService'

const terminal: TerminalConfiguration = {
  terminalId: 'terminal-a',
  terminalCode: 'A',
  displayName: 'Caisse A',
  provisionedAt: '2026-08-01T10:00:00.000Z',
}
const menu = products.find((product) => product.id === 'menu-enfant')!
const item = { ...createCartItemDraft(menu), lineId: 'menu', quantity: 1 }

function services(indexedDb: IDBFactory, databaseName: string) {
  const repository = new IndexedDbOrderRepository(indexedDb, databaseName)
  let orderId = 0
  return {
    repository,
    orders: new OrderService(
      repository,
      () => `order-${++orderId}`,
      () => terminal,
    ),
    ledger: new SalesLedgerService(
      repository,
      () => 'generated-operation',
      () => terminal,
    ),
  }
}

async function alterStoredOrder(indexedDb: IDBFactory, databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(databaseName, 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('orders', 'readwrite')
    const store = transaction.objectStore('orders')
    const read = store.get('order-1')
    read.onsuccess = () => store.put({ ...read.result, totalCents: 1 })
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

async function seedVersionOneDatabase(indexedDb: IDBFactory, databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('orders', { keyPath: 'id' })
      request.result.createObjectStore('metadata', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['orders', 'metadata'], 'readwrite')
    transaction.objectStore('orders').add({ ...structuredClone(printPreviewOrder), id: 'legacy' })
    transaction.objectStore('metadata').put({
      key: 'sequences',
      nextOrderSequence: 2,
      nextReceiptSequence: 2,
    })
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

describe('journal local des encaissements', () => {
  it('scelle la vente et ne modifie que les métadonnées techniques lors de l’impression', async () => {
    const { repository, orders, ledger } = services(new IDBFactory(), 'immutable-sale')
    const order = await orders.createOrder([item], 'card', new Date('2026-09-01T10:00:00Z'))
    const saleBeforePrinting = (await ledger.getEntries())[0]

    expect(order.integrity).toMatchObject({
      algorithm: 'SHA-256',
      journalEntryId: 'sale:order-1',
      journalSequence: 1,
    })
    expect(saleBeforePrinting?.kind).toBe('sale')
    await orders.beginPrinting(order.id, 'both', new Date('2026-09-01T10:01:00Z'))
    await orders.completePrinting(
      order.id,
      'both',
      ['customerReceipt', 'preparationTicket'],
      new Date('2026-09-01T10:02:00Z'),
    )

    const persisted = (await orders.getOrders())[0]!
    expect(persisted.totalCents).toBe(order.totalCents)
    expect(persisted.printing.status).toBe('printed')
    expect(await ledger.getEntries()).toEqual([saleBeforePrinting])
    expect(await ledger.verifyIntegrity()).toMatchObject({
      valid: true,
      complete: true,
      entryCount: 1,
      sealedOrderCount: 1,
    })
    await repository.close()
  })

  it('enregistre un remboursement idempotent sans réécrire la vente originale', async () => {
    const { repository, orders, ledger } = services(new IDBFactory(), 'refund')
    const order = await orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))

    const correction = await ledger.refundSale(
      order.id,
      300,
      'Produit retourné',
      'refund-1',
      new Date('2026-09-01T11:00:00Z'),
    )
    const retry = await ledger.refundSale(
      order.id,
      300,
      'Produit retourné',
      'refund-1',
      new Date('2026-09-01T11:05:00Z'),
    )

    expect(retry).toEqual(correction)
    expect(correction).toMatchObject({
      kind: 'correction',
      correction: {
        originalOrderId: order.id,
        originalOrderNumber: order.orderNumber,
        type: 'refund',
        amountDeltaCents: -300,
        paymentMethod: 'cash',
        originalSaleHash: order.integrity?.hash,
      },
    })
    expect((await orders.getOrders())[0]).toMatchObject({
      id: order.id,
      totalCents: order.totalCents,
      paymentStatus: 'paid',
    })
    expect(await ledger.getEntries()).toHaveLength(2)
    expect((await ledger.verifyIntegrity()).valid).toBe(true)
    await repository.close()
  })

  it('refuse les doubles annulations et un cumul de remboursements supérieur à la vente', async () => {
    const first = services(new IDBFactory(), 'double-cancellation')
    const order = await first.orders.createOrder([item], 'card', new Date('2026-09-01T10:00:00Z'))
    await first.ledger.cancelSale(
      order.id,
      'Commande saisie en double',
      'cancel-1',
      new Date('2026-09-01T11:00:00Z'),
    )
    await expect(
      first.ledger.cancelSale(
        order.id,
        'Nouvel appui',
        'cancel-2',
        new Date('2026-09-01T11:01:00Z'),
      ),
    ).rejects.toThrow(/déjà été annulée/)
    await first.repository.close()

    const second = services(new IDBFactory(), 'refund-limit')
    const refundable = await second.orders.createOrder(
      [item],
      'card',
      new Date('2026-09-01T10:00:00Z'),
    )
    await second.ledger.refundSale(
      refundable.id,
      refundable.totalCents - 1,
      'Remboursement partiel',
      'refund-1',
    )
    await expect(
      second.ledger.refundSale(refundable.id, 2, 'Dépassement', 'refund-2'),
    ).rejects.toThrow(/dépasse le total/)
    await second.repository.close()
  })

  it('chaîne une clôture avec ses totaux et verrouille la période passée', async () => {
    const { repository, orders, ledger } = services(new IDBFactory(), 'closure')
    const order = await orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    await ledger.refundSale(
      order.id,
      100,
      'Remboursement partiel',
      'refund-1',
      new Date('2026-09-01T11:00:00Z'),
    )
    const closure = await ledger.closePeriod(
      new Date('2026-09-01T09:00:00Z'),
      new Date('2026-09-01T12:00:00Z'),
      'closure-1',
      new Date('2026-09-01T13:00:00Z'),
    )

    expect(closure.closure.totals).toEqual({
      saleCount: 1,
      grossSalesCents: order.totalCents,
      correctionCount: 1,
      correctionTotalCents: -100,
      netTotalCents: order.totalCents - 100,
      cumulativeNetTotalCents: order.totalCents - 100,
      paymentTotalsCents: { cash: order.totalCents - 100, card: 0 },
    })
    await expect(orders.createOrder([], 'card', new Date('2026-09-01T11:30:00Z'))).rejects.toThrow(
      /période déjà clôturée/,
    )
    await expect(
      ledger.adjustSale(
        order.id,
        -10,
        'Correction tardive',
        'late-adjustment',
        new Date('2026-09-01T11:30:00Z'),
      ),
    ).rejects.toThrow(/période déjà clôturée/)
    expect(
      (await orders.createOrder([], 'card', new Date('2026-09-01T13:30:00Z'))).orderNumber,
    ).toBe('A-0002')
    await repository.close()
  })

  it('détecte une altération directe des données financières dans IndexedDB', async () => {
    const indexedDb = new IDBFactory()
    const first = services(indexedDb, 'tampering')
    await first.orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    await first.repository.close()
    await alterStoredOrder(indexedDb, 'tampering')

    const reopened = services(indexedDb, 'tampering')
    const verification = await reopened.ledger.verifyIntegrity()
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContain('Données financières altérées pour la commande order-1.')
    await reopened.repository.close()
  })

  it('conserve les commandes de version 1 sans prétendre les sceller rétroactivement', async () => {
    const indexedDb = new IDBFactory()
    await seedVersionOneDatabase(indexedDb, 'legacy-upgrade')
    const upgraded = services(indexedDb, 'legacy-upgrade')

    const [legacy] = await upgraded.orders.getOrders()
    expect(legacy).toMatchObject({ id: 'legacy', printing: printPreviewOrder.printing })
    expect(legacy?.integrity).toBeUndefined()
    expect(await upgraded.ledger.verifyIntegrity()).toMatchObject({
      valid: true,
      complete: false,
      legacyOrderIds: ['legacy'],
    })

    const sealed = await upgraded.orders.createOrder([], 'cash', new Date('2026-09-01T12:00:00Z'))
    expect(sealed.orderNumber).toBe('A-0002')
    expect((await upgraded.ledger.verifyIntegrity()).legacyOrderIds).toEqual(['legacy'])
    await upgraded.repository.close()
  })

  it('exporte une archive vérifiable et la restaure uniquement dans une base vide', async () => {
    const indexedDb = new IDBFactory()
    const source = services(indexedDb, 'archive-source')
    const order = await source.orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    await source.ledger.refundSale(
      order.id,
      100,
      'Remboursement partiel',
      'refund-1',
      new Date('2026-09-01T11:00:00Z'),
    )
    const archive = await source.ledger.exportArchive('archive-1', new Date('2026-09-01T12:00:00Z'))
    expect(source.ledger.verifyArchive(archive)).toMatchObject({ valid: true, complete: true })

    const altered = structuredClone(archive)
    altered.orders[0]!.totalCents += 1
    expect(source.ledger.verifyArchive(altered).valid).toBe(false)

    const target = services(indexedDb, 'archive-target')
    await expect(target.ledger.restoreArchive(altered)).rejects.toThrow(/Restauration refusée/)
    await expect(target.ledger.restoreArchive(archive)).resolves.toEqual({
      restoredOrders: 1,
      restoredEntries: 2,
    })
    expect(await target.orders.getOrders()).toHaveLength(1)
    expect((await target.ledger.verifyIntegrity()).valid).toBe(true)
    await expect(target.ledger.restoreArchive(archive)).rejects.toThrow(/base locale vide/)

    const serializable: SalesArchive = JSON.parse(JSON.stringify(archive)) as SalesArchive
    expect(target.ledger.verifyArchive(serializable).valid).toBe(true)
    await Promise.all([source.repository.close(), target.repository.close()])
  })
})
