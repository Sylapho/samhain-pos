import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'
import type { TerminalConfiguration } from '../types/terminal'
import { createValidOrderItems } from '../test/orderFixtures'

const menu = products.find((product) => product.id === 'menu-enfant')!
const water = products.find((product) => product.id === 'eau')!
const createdAt = new Date('2026-09-01T12:00:00Z')
const terminalA: TerminalConfiguration = {
  terminalId: 'terminal-a',
  terminalCode: 'A',
  displayName: 'Caisse A',
  provisionedAt: '2026-08-01T10:00:00.000Z',
}

function createService(
  indexedDb: IDBFactory,
  databaseName: string,
  id: string,
  terminal = terminalA,
) {
  const repository = new IndexedDbOrderRepository(indexedDb, databaseName)
  return {
    repository,
    service: new OrderService(
      repository,
      () => id,
      () => terminal,
    ),
  }
}

describe('service de commandes persistantes', () => {
  it('marque la préparation non demandée quand aucune ligne ne la nécessite', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'no-preparation', 'order-water')
    const draft = createCartItemDraft(water)

    const order = await service.createOrder(
      [{ ...draft, lineId: 'water', quantity: 2 }],
      'card',
      createdAt,
    )

    expect(order.items[0]?.requiresPreparation).toBe(false)
    expect(order.printing).toMatchObject({
      status: 'pending',
      customerReceipt: 'pending',
      preparationTicket: 'not_requested',
    })
    await repository.close()
  })

  it('termine immédiatement l’impression quand aucun document n’est demandé', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'no-document', 'order-water')
    const draft = createCartItemDraft(water)

    const order = await service.createOrder(
      [{ ...draft, lineId: 'water', quantity: 1 }],
      'cash',
      createdAt,
      false,
    )

    expect(order.printing).toMatchObject({
      status: 'printed',
      customerReceipt: 'not_requested',
      preparationTicket: 'not_requested',
    })
    expect(await service.getRecoverableOrders()).toEqual([])
    await repository.close()
  })

  it('ne fait jamais évoluer un ticket de préparation non demandé pendant la reprise', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'no-preparation-retry', 'order-water')
    const draft = createCartItemDraft(water)
    const order = await service.createOrder(
      [{ ...draft, lineId: 'water', quantity: 1 }],
      'card',
      createdAt,
    )

    const started = await service.beginPrinting(order.id, [
      'pickupTicket',
      'customerReceipt',
      'preparationTicket',
    ])
    expect(started.printing.preparationTicket).toBe('not_requested')

    const failed = await service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      [],
      'Imprimante indisponible',
    )
    expect(failed.printing).toMatchObject({
      status: 'failed',
      customerReceipt: 'failed',
      preparationTicket: 'not_requested',
    })

    const completed = await service.completePrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['customerReceipt'],
    )
    expect(completed.printing).toMatchObject({
      status: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'not_requested',
    })
    await repository.close()
  })
  it('persiste une commande complète avec les choix du menu', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'complete-order', 'order-1')
    const item = createCartItemDraft(menu, {
      optionIdsByGroup: {
        plat: ['nuggets'],
        dessert: ['glace'],
        boisson: ['jus-pomme'],
      },
    })

    const order = await service.createOrder(
      [{ ...item, lineId: 'menu', quantity: 1 }],
      'card',
      createdAt,
    )
    const persistedOrders = await service.getOrders()

    expect(order.orderNumber).toBe('A-0001')
    expect(order.receiptNumber).toBe('R-A-20260901-0001')
    expect(order.terminal).toEqual({
      terminalId: 'terminal-a',
      terminalCode: 'A',
      displayName: 'Caisse A',
    })
    expect(order.paymentMethod).toBe('card')
    expect(order.paymentStatus).toBe('paid')
    expect(order.printing).toMatchObject({
      status: 'pending',
      customerReceipt: 'pending',
      preparationTicket: 'pending',
      attempts: 0,
    })
    expect(order.items[0]?.options.map((option) => option.optionName)).toEqual([
      'Nuggets',
      'Jus de pomme',
      'Glace',
    ])
    expect(order.totalCents).toBe(950)
    expect(order.itemCount).toBe(1)
    expect(await repository.getLedgerEntries()).toHaveLength(1)
    expect(persistedOrders).toEqual([order])

    await repository.close()
  })

  it('retrouve les commandes et poursuit les séquences après un redémarrage', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'restart', 'order-1')
    await first.service.createOrder(createValidOrderItems(), 'cash', createdAt)
    await first.repository.close()

    const restarted = createService(indexedDb, 'restart', 'order-2')
    expect(await restarted.service.getOrders()).toHaveLength(1)

    const secondOrder = await restarted.service.createOrder(
      createValidOrderItems(),
      'card',
      createdAt,
    )
    expect(secondOrder.orderNumber).toBe('A-0002')
    expect(secondOrder.receiptNumber).toBe('R-A-20260901-0002')
    expect(await restarted.service.getOrders()).toHaveLength(2)

    await restarted.repository.close()
  })

  it('retourne les commandes les plus récentes en premier', async () => {
    const indexedDb = new IDBFactory()
    const repository = new IndexedDbOrderRepository(indexedDb, 'recent-orders')
    let idSequence = 0
    const service = new OrderService(
      repository,
      () => `order-${++idSequence}`,
      () => terminalA,
    )

    await service.createOrder(createValidOrderItems(), 'cash', new Date('2026-09-01T10:00:00Z'))
    await service.createOrder(createValidOrderItems(), 'card', new Date('2026-09-01T12:00:00Z'))

    expect((await service.getOrders()).map((order) => order.orderNumber)).toEqual([
      'A-0002',
      'A-0001',
    ])
    await repository.close()
  })

  it('alloue des numéros uniques lors de créations concurrentes', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'concurrent', 'order-1')
    const second = createService(indexedDb, 'concurrent', 'order-2')
    await Promise.all([first.service.getOrders(), second.service.getOrders()])

    const orders = await Promise.all([
      first.service.createOrder(createValidOrderItems(), 'cash', createdAt),
      second.service.createOrder(createValidOrderItems(), 'card', createdAt),
    ])

    expect(new Set(orders.map((order) => order.id)).size).toBe(2)
    expect(orders.map((order) => order.orderNumber).sort()).toEqual(['A-0001', 'A-0002'])
    expect(orders.map((order) => order.receiptNumber).sort()).toEqual([
      'R-A-20260901-0001',
      'R-A-20260901-0002',
    ])
    expect(await first.service.getOrders()).toHaveLength(2)

    await Promise.all([first.repository.close(), second.repository.close()])
  })

  it('annule aussi l’incrément si l’identifiant durable existe déjà', async () => {
    const indexedDb = new IDBFactory()
    const duplicate = createService(indexedDb, 'rollback', 'same-id')
    await duplicate.service.createOrder(createValidOrderItems(), 'cash', createdAt)
    await expect(
      duplicate.service.createOrder(createValidOrderItems(), 'card', createdAt),
    ).rejects.toBeTruthy()

    const recovered = createService(indexedDb, 'rollback', 'new-id')
    const nextOrder = await recovered.service.createOrder(
      createValidOrderItems(),
      'card',
      createdAt,
    )

    expect(nextOrder.orderNumber).toBe('A-0002')
    expect(nextOrder.receiptNumber).toBe('R-A-20260901-0002')
    expect(await recovered.service.getOrders()).toHaveLength(2)

    await Promise.all([duplicate.repository.close(), recovered.repository.close()])
  })

  it('produit des numéros humains distincts sur quatre installations A, B, C et D', async () => {
    const codes = ['A', 'B', 'C', 'D'] as const
    const installations = codes.map((terminalCode) =>
      createService(new IDBFactory(), `terminal-${terminalCode}`, `order-${terminalCode}`, {
        ...terminalA,
        terminalId: `terminal-${terminalCode}`,
        terminalCode,
        displayName: `Caisse ${terminalCode}`,
      }),
    )

    const orders = await Promise.all(
      installations.map(({ service }) =>
        service.createOrder(createValidOrderItems(), 'cash', createdAt),
      ),
    )

    expect(orders.map((order) => order.orderNumber)).toEqual([
      'A-0001',
      'B-0001',
      'C-0001',
      'D-0001',
    ])
    expect(new Set(orders.map((order) => order.receiptNumber)).size).toBe(4)
    await Promise.all(installations.map(({ repository }) => repository.close()))
  })

  it('conserve dans la commande le nom de caisse au moment de la vente', async () => {
    const current = { ...terminalA }
    const repository = new IndexedDbOrderRepository(new IDBFactory(), 'terminal-snapshot')
    const service = new OrderService(
      repository,
      () => 'order-1',
      () => current,
    )

    const order = await service.createOrder(createValidOrderItems(), 'cash', createdAt)
    current.displayName = 'Caisse accueil'

    expect((await service.getOrders())[0]?.terminal?.displayName).toBe('Caisse A')
    expect(order.terminal?.terminalId).toBe('terminal-a')
    await repository.close()
  })

  it('refuse la création avant provisioning sans consommer de séquence', async () => {
    const indexedDb = new IDBFactory()
    const repository = new IndexedDbOrderRepository(indexedDb, 'missing-terminal')
    const unconfigured = new OrderService(
      repository,
      () => 'order-rejected',
      () => {
        throw new Error('Tablette non configurée')
      },
    )

    expect(() => unconfigured.createOrder(createValidOrderItems(), 'cash', createdAt)).toThrow(
      /non configurée/,
    )

    const configured = new OrderService(
      repository,
      () => 'order-accepted',
      () => terminalA,
    )
    expect(
      (await configured.createOrder(createValidOrderItems(), 'cash', createdAt)).orderNumber,
    ).toBe('A-0001')
    await repository.close()
  })

  it('persiste un échec partiel et reprend seulement le ticket restant après redémarrage', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'print-lifecycle', 'order-1')
    const order = await first.service.createOrder(createValidOrderItems(), 'cash', createdAt)

    await first.service.beginPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )
    const partial = await first.service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt'],
      'Préparation interrompue.',
      createdAt,
    )
    expect(partial.printing).toMatchObject({
      status: 'partial',
      pickupTicket: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'failed',
      attempts: 1,
      lastError: 'Préparation interrompue.',
    })
    await first.repository.close()

    const restarted = createService(indexedDb, 'print-lifecycle', 'order-2')
    expect((await restarted.service.getRecoverableOrders())[0]?.id).toBe(order.id)
    await restarted.service.beginPrinting(order.id, ['preparationTicket'], createdAt)
    const printed = await restarted.service.completePrinting(
      order.id,
      ['preparationTicket'],
      ['preparationTicket'],
      createdAt,
    )

    expect(printed.printing).toMatchObject({
      status: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'printed',
      attempts: 2,
    })
    expect(await restarted.service.getRecoverableOrders()).toEqual([])
    await restarted.repository.close()
  })

  it('conserve la vente différée et n’alloue un nouveau numéro que pour la vente suivante', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'deferred-numbering', 'order-1')
    const firstOrder = await first.service.createOrder(createValidOrderItems(), 'cash', createdAt)
    await first.service.beginPrinting(
      firstOrder.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )
    const deferredOrder = await first.service.failPrinting(
      firstOrder.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt'],
      'Préparation interrompue.',
      createdAt,
    )
    await first.repository.close()

    const restarted = createService(indexedDb, 'deferred-numbering', 'order-2')
    const [recovered] = await restarted.service.getRecoverableOrders()
    expect(recovered).toMatchObject({
      id: deferredOrder.id,
      orderNumber: deferredOrder.orderNumber,
      receiptNumber: deferredOrder.receiptNumber,
      terminal: deferredOrder.terminal,
      paymentMethod: deferredOrder.paymentMethod,
      paymentStatus: 'paid',
      paidAt: deferredOrder.paidAt,
      createdAt: deferredOrder.createdAt,
      items: deferredOrder.items,
      printing: deferredOrder.printing,
    })

    const secondOrder = await restarted.service.createOrder(
      createValidOrderItems(),
      'card',
      new Date('2026-09-01T12:01:00Z'),
    )
    expect(secondOrder.orderNumber).toBe('A-0002')
    expect(secondOrder.receiptNumber).toBe('R-A-20260901-0002')

    await restarted.service.beginPrinting(firstOrder.id, ['preparationTicket'], createdAt)
    const completedFirstOrder = await restarted.service.completePrinting(
      firstOrder.id,
      ['preparationTicket'],
      ['preparationTicket'],
      createdAt,
    )
    expect(completedFirstOrder).toMatchObject({
      id: firstOrder.id,
      orderNumber: 'A-0001',
      receiptNumber: 'R-A-20260901-0001',
      paymentMethod: 'cash',
      printing: {
        status: 'printed',
        pickupTicket: 'printed',
        customerReceipt: 'printed',
        preparationTicket: 'printed',
      },
    })
    expect((await restarted.service.getOrders()).map((order) => order.orderNumber).sort()).toEqual([
      'A-0001',
      'A-0002',
    ])
    await restarted.repository.close()
  })

  it('persiste un transfert partiel comme inconnu sans perdre le ticket terminé', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'unknown-transfer', 'order-1')
    const order = await first.service.createOrder(createValidOrderItems(), 'cash', createdAt)

    await first.service.beginPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )
    const ambiguous = await first.service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt'],
      'Préparation partiellement transmise.',
      ['preparationTicket'],
      createdAt,
    )

    expect(ambiguous.printing).toMatchObject({
      status: 'unknown',
      pickupTicket: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'unknown',
    })
    await first.repository.close()

    const restarted = createService(indexedDb, 'unknown-transfer', 'order-2')
    const [recovered] = await restarted.service.getRecoverableOrders()
    expect(recovered?.printing).toMatchObject({
      status: 'unknown',
      pickupTicket: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'unknown',
    })
    await restarted.repository.close()
  })

  it('distingue un ticket client partiel d’un échec avant le premier octet', async () => {
    const { repository, service } = createService(
      new IDBFactory(),
      'customer-transfer-states',
      'order-1',
    )
    const order = await service.createOrder(createValidOrderItems(), 'card', createdAt)
    await service.beginPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )

    const ambiguous = await service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket'],
      'Ticket client partiellement transmis.',
      ['customerReceipt'],
      createdAt,
    )

    expect(ambiguous.printing).toMatchObject({
      status: 'unknown',
      pickupTicket: 'printed',
      customerReceipt: 'unknown',
      preparationTicket: 'failed',
    })

    const secondService = new OrderService(
      repository,
      () => 'order-2',
      () => terminalA,
    )
    const secondOrder = await secondService.createOrder(createValidOrderItems(), 'card', createdAt)
    await secondService.beginPrinting(
      secondOrder.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )
    const retryable = await secondService.failPrinting(
      secondOrder.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket'],
      'Aucun octet envoyé.',
      [],
      createdAt,
    )
    expect(retryable.printing).toMatchObject({
      status: 'partial',
      pickupTicket: 'printed',
      customerReceipt: 'failed',
      preparationTicket: 'failed',
    })
    await repository.close()
  })

  it('mémorise qu’un ticket client a été refusé avant toute impression', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'no-customer-ticket', 'order-1')
    const order = await service.createOrder(createValidOrderItems(), 'card', createdAt, false)

    expect(order.printing.customerReceipt).toBe('not_requested')
    await service.beginPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      createdAt,
    )
    const printed = await service.completePrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'preparationTicket'],
      createdAt,
    )
    expect(printed.printing.status).toBe('printed')
    await repository.close()
  })

  it('conserve les réussites après plusieurs échecs et une interruption de reprise', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'interrupted-retry', 'order-1')
    const order = await first.service.createOrder(createValidOrderItems(), 'cash', createdAt)
    await first.service.beginPrinting(order.id, [
      'pickupTicket',
      'customerReceipt',
      'preparationTicket',
    ])
    await first.service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt'],
      'Préparation échouée',
    )
    await first.service.beginPrinting(order.id, ['preparationTicket'])
    const failed = await first.service.failPrinting(
      order.id,
      ['preparationTicket'],
      [],
      'Déconnexion',
    )
    expect(failed.printing).toMatchObject({
      status: 'partial',
      pickupTicket: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'failed',
    })
    await first.service.beginPrinting(order.id, ['preparationTicket'])
    await first.repository.close()

    const restarted = createService(indexedDb, 'interrupted-retry', 'order-2')
    const [recovered] = await restarted.service.getRecoverableOrders()
    expect(recovered?.printing).toMatchObject({
      status: 'unknown',
      pickupTicket: 'printed',
      customerReceipt: 'printed',
      preparationTicket: 'unknown',
      attempts: 3,
    })
    expect(recovered?.paymentStatus).toBe('paid')
    await restarted.repository.close()
  })

  it('ne perd pas une réussite connue si une sélection inclut à nouveau le document', async () => {
    const { repository, service } = createService(new IDBFactory(), 'preserve-success', 'order-1')
    const order = await service.createOrder(createValidOrderItems(), 'card', createdAt)
    await service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['pickupTicket', 'customerReceipt'],
      'Préparation échouée',
    )
    const started = await service.beginPrinting(order.id, [
      'pickupTicket',
      'customerReceipt',
      'preparationTicket',
    ])
    expect(started.printing.customerReceipt).toBe('printed')
    const failed = await service.failPrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      [],
      'Déconnexion',
    )
    expect(failed.printing.customerReceipt).toBe('printed')
    const completed = await service.completePrinting(
      order.id,
      ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      ['preparationTicket'],
    )
    expect(completed.printing.status).toBe('printed')
    await repository.close()
  })
})
