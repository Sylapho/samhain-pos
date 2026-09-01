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
        optionIds: {
          plat: 'steak-frites',
          dessert: 'glace-vanille',
          boisson: 'jus-fruit',
        },
      }),
    )
    const order = createMockOrder(useCartStore.getState().items)
    expect(order.orderNumber).toBe('#042')
    expect(order.items).toHaveLength(1)
    expect(order.items[0]?.options.map((option) => option.optionName)).toEqual([
      'Steak haché + frites',
      'Glace vanille — 1 boule',
      'Jus de fruit',
    ])
    expect(order.totalCents).toBe(950)
  })

  it('crée un nouveau numéro pour la commande suivante', () => {
    const first = createMockOrder([])
    const second = createMockOrder([])
    expect(first.orderNumber).toBe('#042')
    expect(second.orderNumber).toBe('#043')
  })
})
