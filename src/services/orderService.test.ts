import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { createCartItemDraft } from '../utils/cart'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'

const menu = products.find((product) => product.id === 'menu-enfant')!
const createdAt = new Date('2026-09-01T12:00:00Z')

function createService(indexedDb: IDBFactory, databaseName: string, id: string) {
  const repository = new IndexedDbOrderRepository(indexedDb, databaseName)
  return { repository, service: new OrderService(repository, () => id) }
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

    expect(order.orderNumber).toBe('A001')
    expect(order.receiptNumber).toBe('R-20260901-0001')
    expect(order.paymentMethod).toBe('card')
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
    expect(secondOrder.orderNumber).toBe('A002')
    expect(secondOrder.receiptNumber).toBe('R-20260901-0002')
    expect(await restarted.service.getOrders()).toHaveLength(2)

    await restarted.repository.close()
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
    expect(orders.map((order) => order.orderNumber).sort()).toEqual(['A001', 'A002'])
    expect(orders.map((order) => order.receiptNumber).sort()).toEqual([
      'R-20260901-0001',
      'R-20260901-0002',
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

    expect(nextOrder.orderNumber).toBe('A002')
    expect(nextOrder.receiptNumber).toBe('R-20260901-0002')
    expect(await recovered.service.getOrders()).toHaveLength(2)

    await Promise.all([duplicate.repository.close(), recovered.repository.close()])
  })
})
