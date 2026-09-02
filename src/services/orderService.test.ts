import { beforeEach, describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { useCartStore } from '../store/cartStore'
import { createCartItemDraft } from '../utils/cart'
import { createMockOrder, resetMockOrderSequenceForTests } from './orderService'

const menu = products.find((product) => product.id === 'menu-enfant')!

describe('mock order service', () => {
  beforeEach(() => {
    useCartStore.getState().clearCart()
    resetMockOrderSequenceForTests()
  })

  it('conserve le menu enfant comme une seule ligne avec ses trois choix', () => {
    useCartStore.getState().addItem(
      createCartItemDraft(menu, {
        optionIdsByGroup: {
          plat: ['nuggets'],
          dessert: ['glace'],
          boisson: ['jus-pomme'],
        },
      }),
    )
    const order = createMockOrder(
      useCartStore.getState().items,
      'card',
      new Date('2026-09-01T12:00:00Z'),
    )
    expect(order.orderNumber).toBe('A001')
    expect(order.receiptNumber).toBe('R-20260901-0001')
    expect(order.paymentMethod).toBe('card')
    expect(order.items).toHaveLength(1)
    expect(order.items[0]?.options.map((option) => option.optionName)).toEqual([
      'Nuggets',
      'Jus de pomme',
      'Glace',
    ])
    expect(order.totalCents).toBe(950)
  })

  it('crée un nouveau numéro pour la commande suivante', () => {
    const first = createMockOrder([], 'cash')
    const second = createMockOrder([], 'card')
    expect(first.orderNumber).toBe('A001')
    expect(second.orderNumber).toBe('A002')
  })
})
