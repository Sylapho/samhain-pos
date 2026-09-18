import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { initialCatalogProducts as products } from '../data/initialCatalog'
import type { CorrectionLedgerEntry, SalesArchive } from '../types/salesLedger'
import type { TerminalConfiguration } from '../types/terminal'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'
import { SalesLedgerService } from './salesLedgerService'
import { CashSessionService } from './cashSessionService'
import { deriveSaleCorrectionSummary } from './saleCorrectionSummary'

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
      undefined,
      () => {},
    ),
    cashSessions: new CashSessionService(
      repository,
      () => 'cash-session-1',
      () => terminal,
      undefined,
      () => {},
    ),
  }
}

async function alterStoredOrder(indexedDb: IDBFactory, databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(databaseName, 4)
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
  it('refuse toutes les opérations sensibles avant d’atteindre le repository', async () => {
    const repository = {
      getOrders: vi.fn(),
      recordCorrection: vi.fn(),
      closePeriod: vi.fn(),
      exportArchive: vi.fn(),
      restoreArchive: vi.fn(),
    } as unknown as ConstructorParameters<typeof SalesLedgerService>[0]
    const service = new SalesLedgerService(
      repository,
      vi.fn(() => 'operation-id'),
      () => terminal,
      undefined,
      () => {
        throw new Error('Mode responsable requis pour cette opération.')
      },
    )
    const archive = { version: 1 } as unknown as SalesArchive

    await expect(service.cancelSale('order-1', 'raison')).rejects.toThrow(/Mode responsable requis/)
    await expect(
      service.refundSale('order-1', [{ originalLineId: 'line', quantity: 1 }], 'raison'),
    ).rejects.toThrow(/Mode responsable requis/)
    expect(() => service.adjustSale('order-1', -100, 'raison')).toThrow(/Mode responsable requis/)
    expect(() => service.closePeriod(new Date(0), new Date(1))).toThrow(/Mode responsable requis/)
    expect(() => service.exportArchive()).toThrow(/Mode responsable requis/)
    expect(() => service.restoreArchive(archive)).toThrow(/Mode responsable requis/)

    expect(repository.getOrders).not.toHaveBeenCalled()
    expect(repository.recordCorrection).not.toHaveBeenCalled()
    expect(repository.closePeriod).not.toHaveBeenCalled()
    expect(repository.exportArchive).not.toHaveBeenCalled()
    expect(repository.restoreArchive).not.toHaveBeenCalled()
  })

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
    await orders.beginPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      new Date('2026-09-01T10:01:00Z'),
    )
    await orders.completePrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
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
      [{ originalLineId: item.lineId, quantity: 1 }],
      'Produit retourné',
      'refund-1',
      new Date('2026-09-01T11:00:00Z'),
    )
    const retry = await ledger.refundSale(
      order.id,
      [{ originalLineId: item.lineId, quantity: 1 }],
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
        amountDeltaCents: -order.totalCents,
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

  it('persiste plusieurs remboursements par lignes, revalide le restant et épuise le reliquat exact', async () => {
    const indexedDb = new IDBFactory()
    const first = services(indexedDb, 'structured-refunds')
    await first.cashSessions.openSession(0, new Date('2026-09-01T09:00:00Z'))
    const order = await first.orders.createOrder(
      structuredClone(printPreviewOrder.items),
      'card',
      new Date('2026-09-01T10:00:00Z'),
    )
    const original = structuredClone(order)
    const [burger, crepe, beer] = order.items

    const firstRefund = await first.ledger.refundSale(
      order.id,
      [{ originalLineId: burger!.lineId, quantity: 1 }],
      'Un burger retourné',
      'structured-1',
      new Date('2026-09-01T10:15:00Z'),
    )
    expect(firstRefund.correction.refundLines).toEqual([
      expect.objectContaining({
        originalLineId: burger!.lineId,
        productId: burger!.productId,
        quantity: 1,
        unitPriceCents: 1600,
        vatRate: 10,
        grossCents: 1600,
        vatCents: 145,
      }),
    ])
    await first.repository.close()

    const reopened = services(indexedDb, 'structured-refunds')
    const persistedOrder = (await reopened.orders.getOrders())[0]!
    let corrections = (await reopened.ledger.getEntries()).filter(
      (entry): entry is CorrectionLedgerEntry => entry.kind === 'correction',
    )
    expect(deriveSaleCorrectionSummary(persistedOrder, corrections).refundableLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ originalLineId: burger!.lineId, remainingQuantity: 1 }),
      ]),
    )
    await expect(
      reopened.ledger.refundSale(
        order.id,
        [{ originalLineId: burger!.lineId, quantity: 2 }],
        'État UI devenu obsolète',
        'structured-stale',
        new Date('2026-09-01T10:20:00Z'),
      ),
    ).rejects.toThrow(/quantité remboursable restante/i)

    await reopened.ledger.refundSale(
      order.id,
      [
        { originalLineId: burger!.lineId, quantity: 1 },
        { originalLineId: beer!.lineId, quantity: 2 },
      ],
      'Deux lignes',
      'structured-2',
      new Date('2026-09-01T10:30:00Z'),
    )
    const preview = await reopened.ledger.previewClosure(
      new Date('2026-09-01T09:00:00Z'),
      new Date('2026-09-01T12:00:00Z'),
      new Date('2026-09-01T13:00:00Z'),
    )
    expect(preview.totals).toMatchObject({
      grossSalesCents: 4150,
      correctionTotalCents: -3900,
      netTotalCents: 250,
    })
    expect(preview.vatBreakdown).toEqual([
      { rate: 10, grossCents: 250, netCents: 227, vatCents: 23 },
      { rate: 20, grossCents: 0, netCents: 0, vatCents: 0 },
    ])
    await reopened.ledger.refundSale(
      order.id,
      [{ originalLineId: crepe!.lineId, quantity: 1 }],
      'Reliquat exact',
      'structured-3',
      new Date('2026-09-01T10:45:00Z'),
    )

    corrections = (await reopened.ledger.getEntries()).filter(
      (entry): entry is CorrectionLedgerEntry => entry.kind === 'correction',
    )
    expect(deriveSaleCorrectionSummary(persistedOrder, corrections)).toMatchObject({
      status: 'refunded',
      remainingRefundableCents: 0,
      canRefund: false,
    })
    await expect(
      reopened.ledger.refundSale(
        order.id,
        [{ originalLineId: crepe!.lineId, quantity: 1 }],
        'Tentative supplémentaire',
        'structured-4',
        new Date('2026-09-01T10:50:00Z'),
      ),
    ).rejects.toThrow(/quantité remboursable restante/i)
    expect((await reopened.orders.getOrders())[0]).toEqual(original)
    expect((await reopened.ledger.verifyIntegrity()).valid).toBe(true)
    const archive = await reopened.ledger.exportArchive('structured-refunds-archive')
    const altered = structuredClone(archive)
    const alteredRefund = altered.entries.find(
      (entry): entry is CorrectionLedgerEntry => entry.kind === 'correction',
    )
    alteredRefund!.correction.refundLines![0]!.quantity += 1
    expect(reopened.ledger.verifyArchive(altered).valid).toBe(false)
    await reopened.repository.close()
  })

  it('annule intégralement avec un motif et conserve strictement la vente originale', async () => {
    const { repository, orders, ledger } = services(new IDBFactory(), 'cancellation-immutable')
    const order = await orders.createOrder([item], 'card', new Date('2026-09-01T10:00:00Z'))
    const original = structuredClone(order)

    const correction = await ledger.cancelSale(
      order.id,
      'Erreur de saisie',
      'cancel-immutable',
      new Date('2026-09-01T11:00:00Z'),
    )

    expect(correction.correction).toMatchObject({
      originalOrderId: order.id,
      type: 'cancellation',
      reason: 'Erreur de saisie',
      amountDeltaCents: -order.totalCents,
    })
    expect((await orders.getOrders())[0]).toEqual(original)
    expect((await ledger.getEntries()).filter((entry) => entry.kind === 'correction')).toEqual([
      correction,
    ])
    await repository.close()
  })

  it.each(['', '   '])('refuse un motif vide « %s »', async (reason) => {
    const { repository, orders, ledger } = services(
      new IDBFactory(),
      `empty-reason-${reason.length}`,
    )
    const order = await orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))

    await expect(
      ledger.refundSale(
        order.id,
        [{ originalLineId: item.lineId, quantity: 1 }],
        reason,
        'empty-reason',
      ),
    ).rejects.toThrow(/motif.*requis/i)
    expect((await ledger.getEntries()).filter((entry) => entry.kind === 'correction')).toEqual([])
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
      [{ originalLineId: item.lineId, quantity: 1 }],
      'Remboursement partiel',
      'refund-1',
    )
    await expect(
      second.ledger.refundSale(
        refundable.id,
        [{ originalLineId: item.lineId, quantity: 1 }],
        'Dépassement',
        'refund-2',
      ),
    ).rejects.toThrow(/quantité remboursable restante/i)
    await second.repository.close()
  })

  it('chaîne une clôture avec ses totaux et verrouille la période passée', async () => {
    const { repository, orders, ledger, cashSessions } = services(new IDBFactory(), 'closure')
    await cashSessions.openSession(15_000, new Date('2026-09-01T09:00:00Z'))
    const order = await orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    await ledger.refundSale(
      order.id,
      [{ originalLineId: item.lineId, quantity: 1 }],
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
      correctionTotalCents: -order.totalCents,
      netTotalCents: 0,
      cumulativeNetTotalCents: 0,
      paymentTotalsCents: { cash: 0, card: 0 },
    })
    expect(closure.closure).toMatchObject({
      cashSessionId: 'cash-session-1',
      openingFloatCents: 15_000,
      theoreticalCashCents: 15_000,
    })
    await expect(
      orders.createOrder([item], 'card', new Date('2026-09-01T11:30:00Z')),
    ).rejects.toThrow(/période déjà clôturée/)
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
      (await orders.createOrder([item], 'card', new Date('2026-09-01T13:30:00Z'))).orderNumber,
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

    const sealed = await upgraded.orders.createOrder(
      [item],
      'cash',
      new Date('2026-09-01T12:00:00Z'),
    )
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
      [{ originalLineId: item.lineId, quantity: 1 }],
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
    expect(() => target.ledger.restoreArchive(altered)).toThrow(/Restauration refusée/)
    const wrongTerminal = new SalesLedgerService(
      target.repository,
      () => 'unused',
      () => ({
        terminalId: 'terminal-b',
        terminalCode: 'B',
        displayName: 'Caisse B',
        provisionedAt: '2026-09-01T00:00:00.000Z',
      }),
      undefined,
      () => {},
    )
    expect(() => wrongTerminal.restoreArchive(archive)).toThrow(/appartient à Caisse A.*Caisse B/)
    const wrongTechnicalIdentity = new SalesLedgerService(
      target.repository,
      () => 'unused',
      () => ({ ...terminal, terminalId: 'another-terminal-a' }),
      undefined,
      () => {},
    )
    expect(() => wrongTechnicalIdentity.restoreArchive(archive)).toThrow(/autre identité technique/)
    expect(await target.orders.getOrders()).toEqual([])
    expect(await target.ledger.getEntries()).toEqual([])
    expect(await target.repository.getArchiveRestoreTargetState(archive)).toBe('empty')

    const renamedSameTerminal = new SalesLedgerService(
      target.repository,
      () => 'unused',
      () => ({ ...terminal, displayName: 'Caisse accueil' }),
      undefined,
      () => {},
    )
    await expect(renamedSameTerminal.restoreArchive(archive)).resolves.toEqual({
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

  it('exporte sans clôture préalable sans supprimer les ventes locales', async () => {
    const { repository, orders, ledger } = services(new IDBFactory(), 'archive-without-closure')
    const order = await orders.createOrder([item], 'card', new Date('2026-09-01T10:00:00Z'))

    const archive = await ledger.exportArchive(
      'archive-without-closure',
      new Date('2026-09-01T11:00:00Z'),
    )

    expect(ledger.verifyArchive(archive).valid).toBe(true)
    expect(archive.entries.some((entry) => entry.kind === 'closure')).toBe(false)
    expect((await orders.getOrders()).map((stored) => stored.id)).toEqual([order.id])
    expect(await ledger.getEntries()).toHaveLength(1)
    await repository.close()
  })

  it('prévisualise depuis le ledger persisté avec corrections, CB et espèces', async () => {
    const { repository, orders, ledger, cashSessions } = services(
      new IDBFactory(),
      'closure-preview',
    )
    await cashSessions.openSession(15_000, new Date('2026-09-01T09:00:00Z'))
    const cashOrder = await orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    const cardOrder = await orders.createOrder([item], 'card', new Date('2026-09-01T10:30:00Z'))
    await ledger.refundSale(
      cardOrder.id,
      [{ originalLineId: item.lineId, quantity: 1 }],
      'Remboursement partiel',
      'refund-preview',
      new Date('2026-09-01T11:00:00Z'),
    )

    const preview = await ledger.previewClosure(
      new Date('2026-09-01T09:00:00Z'),
      new Date('2026-09-01T12:00:00Z'),
      new Date('2026-09-01T13:00:00Z'),
    )

    expect(preview.totals).toEqual({
      saleCount: 2,
      grossSalesCents: cashOrder.totalCents + cardOrder.totalCents,
      correctionCount: 1,
      correctionTotalCents: -cardOrder.totalCents,
      netTotalCents: cashOrder.totalCents,
      cumulativeNetTotalCents: cashOrder.totalCents,
      paymentTotalsCents: {
        cash: cashOrder.totalCents,
        card: 0,
      },
    })
    expect(preview.theoreticalCashCents).toBe(15_000 + cashOrder.totalCents)
    expect(preview.vatBreakdown).toEqual([
      {
        rate: item.vatRate,
        grossCents: cashOrder.totalCents,
        netCents:
          cashOrder.totalCents -
          Math.round((cashOrder.totalCents * item.vatRate) / (100 + item.vatRate)),
        vatCents: Math.round((cashOrder.totalCents * item.vatRate) / (100 + item.vatRate)),
      },
    ])

    const closure = await ledger.closePeriod(
      new Date(preview.periodStart),
      new Date(preview.periodEnd),
      'preview-closure',
      new Date('2026-09-01T13:00:00Z'),
    )
    expect(closure.closure.totals).toEqual(preview.totals)
    expect(await orders.getOrders()).toHaveLength(2)
    expect((await ledger.getEntries()).map((entry) => entry.kind)).toEqual([
      'cash_session_opened',
      'sale',
      'sale',
      'correction',
      'closure',
    ])
    await repository.close()
  })

  it('ne devine pas la TVA d’un ancien remboursement limité à un montant', async () => {
    const seeded = services(new IDBFactory(), 'legacy-refund-vat')
    await seeded.cashSessions.openSession(0, new Date('2026-09-01T09:00:00Z'))
    const order = await seeded.orders.createOrder([item], 'cash', new Date('2026-09-01T10:00:00Z'))
    await seeded.ledger.refundSale(
      order.id,
      [{ originalLineId: item.lineId, quantity: 1 }],
      'Ancienne correction simulée',
      'legacy-refund',
      new Date('2026-09-01T11:00:00Z'),
    )
    const entries = structuredClone(await seeded.ledger.getEntries())
    const legacy = entries.find(
      (entry): entry is CorrectionLedgerEntry => entry.kind === 'correction',
    )!
    delete legacy.correction.refundLines
    const integrity = await seeded.ledger.verifyIntegrity()
    const repository = {
      getLedgerEntries: vi.fn(async () => entries),
      verifyIntegrity: vi.fn(async () => integrity),
    } as unknown as ConstructorParameters<typeof SalesLedgerService>[0]
    const service = new SalesLedgerService(
      repository,
      () => 'unused',
      () => terminal,
      undefined,
      () => {},
    )

    const preview = await service.previewClosure(
      new Date('2026-09-01T09:00:00Z'),
      new Date('2026-09-01T12:00:00Z'),
      new Date('2026-09-01T13:00:00Z'),
    )
    expect(preview.vatBreakdown).toBeNull()
    expect(preview.vatUnavailableReason).toMatch(/historique.*détail fiscal fiable/i)
    await seeded.repository.close()
  })

  it('refuse explicitement les périodes de clôture invalides', async () => {
    const { repository, ledger } = services(new IDBFactory(), 'invalid-closure-period')
    const start = new Date('2026-09-01T12:00:00Z')

    await expect(
      ledger.previewClosure(start, start, new Date('2026-09-01T13:00:00Z')),
    ).rejects.toThrow(/postérieure/)
    expect(() =>
      ledger.closePeriod(new Date('invalid'), new Date('2026-09-01T12:00:00Z'), 'invalid-date'),
    ).toThrow(/dates.*invalides/i)
    await repository.close()
  })
})
