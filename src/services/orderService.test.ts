import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'
import type { TerminalConfiguration } from '../types/terminal'

const menu = products.find((product) => product.id === 'menu-enfant')!
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
    expect(persistedOrders).toEqual([order])

    await repository.close()
  })

  it('retrouve les commandes et poursuit les séquences après un redémarrage', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'restart', 'order-1')
    await first.service.createOrder([], 'cash', createdAt)
    await first.repository.close()

    const restarted = createService(indexedDb, 'restart', 'order-2')
    expect(await restarted.service.getOrders()).toHaveLength(1)

    const secondOrder = await restarted.service.createOrder([], 'card', createdAt)
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

    await service.createOrder([], 'cash', new Date('2026-09-01T10:00:00Z'))
    await service.createOrder([], 'card', new Date('2026-09-01T12:00:00Z'))

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
      first.service.createOrder([], 'cash', createdAt),
      second.service.createOrder([], 'card', createdAt),
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
    await duplicate.service.createOrder([], 'cash', createdAt)
    await expect(duplicate.service.createOrder([], 'card', createdAt)).rejects.toBeTruthy()

    const recovered = createService(indexedDb, 'rollback', 'new-id')
    const nextOrder = await recovered.service.createOrder([], 'card', createdAt)

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
      installations.map(({ service }) => service.createOrder([], 'cash', createdAt)),
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

    const order = await service.createOrder([], 'cash', createdAt)
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

    expect(() => unconfigured.createOrder([], 'cash', createdAt)).toThrow(/non configurée/)

    const configured = new OrderService(
      repository,
      () => 'order-accepted',
      () => terminalA,
    )
    expect((await configured.createOrder([], 'cash', createdAt)).orderNumber).toBe('A-0001')
    await repository.close()
  })

  it('persiste un échec partiel et reprend seulement le ticket restant après redémarrage', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'print-lifecycle', 'order-1')
    const order = await first.service.createOrder([], 'cash', createdAt)

    await first.service.beginPrinting(order.id, 'both', createdAt)
    const partial = await first.service.failPrinting(
      order.id,
      'both',
      ['customerReceipt'],
      'Préparation interrompue.',
      createdAt,
    )
    expect(partial.printing).toMatchObject({
      status: 'partial',
      customerReceipt: 'printed',
      preparationTicket: 'failed',
      attempts: 1,
      lastError: 'Préparation interrompue.',
    })
    await first.repository.close()

    const restarted = createService(indexedDb, 'print-lifecycle', 'order-2')
    expect((await restarted.service.getRecoverableOrders())[0]?.id).toBe(order.id)
    await restarted.service.beginPrinting(order.id, 'preparation', createdAt)
    const printed = await restarted.service.completePrinting(
      order.id,
      'preparation',
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

  it('mémorise qu’un ticket client a été refusé avant toute impression', async () => {
    const indexedDb = new IDBFactory()
    const { repository, service } = createService(indexedDb, 'no-customer-ticket', 'order-1')
    const order = await service.createOrder([], 'card', createdAt, false)

    expect(order.printing.customerReceipt).toBe('not_requested')
    await service.beginPrinting(order.id, 'both', createdAt)
    const printed = await service.completePrinting(
      order.id,
      'both',
      ['preparationTicket'],
      createdAt,
    )
    expect(printed.printing.status).toBe('printed')
    await repository.close()
  })

  it('conserve les réussites après plusieurs échecs et une interruption de reprise', async () => {
    const indexedDb = new IDBFactory()
    const first = createService(indexedDb, 'interrupted-retry', 'order-1')
    const order = await first.service.createOrder([], 'cash', createdAt)
    await first.service.beginPrinting(order.id, 'both')
    await first.service.failPrinting(order.id, 'both', ['customerReceipt'], 'Préparation échouée')
    await first.service.beginPrinting(order.id, 'preparation')
    const failed = await first.service.failPrinting(order.id, 'preparation', [], 'Déconnexion')
    expect(failed.printing).toMatchObject({
      status: 'partial',
      customerReceipt: 'printed',
      preparationTicket: 'failed',
    })
    await first.service.beginPrinting(order.id, 'preparation')
    await first.repository.close()

    const restarted = createService(indexedDb, 'interrupted-retry', 'order-2')
    const [recovered] = await restarted.service.getRecoverableOrders()
    expect(recovered?.printing).toMatchObject({
      status: 'unknown',
      customerReceipt: 'printed',
      preparationTicket: 'unknown',
      attempts: 3,
    })
    expect(recovered?.paymentStatus).toBe('paid')
    await restarted.repository.close()
  })

  it('ne perd pas une réussite connue si une sélection inclut à nouveau le document', async () => {
    const { repository, service } = createService(new IDBFactory(), 'preserve-success', 'order-1')
    const order = await service.createOrder([], 'card', createdAt)
    await service.failPrinting(order.id, 'both', ['customerReceipt'], 'Préparation échouée')
    const started = await service.beginPrinting(order.id, 'both')
    expect(started.printing.customerReceipt).toBe('printed')
    const failed = await service.failPrinting(order.id, 'both', [], 'Déconnexion')
    expect(failed.printing.customerReceipt).toBe('printed')
    const completed = await service.completePrinting(order.id, 'both', ['preparationTicket'])
    expect(completed.printing.status).toBe('printed')
    await repository.close()
  })
})
