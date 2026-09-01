import { beforeEach, describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { createCartItemDraft } from '../utils/cart'
import { getCartTotalCents, useCartStore } from './cartStore'

const burger = products.find((product) => product.id === 'burger-samhain')!
const prestige = products.find((product) => product.id === 'biere-prestige')!
const tea = products.find((product) => product.id === 'the')!

describe('cart store', () => {
  beforeEach(() => useCartStore.getState().clearCart())

  it('fusionne deux lignes strictement identiques', () => {
    const draft = createCartItemDraft(burger)
    useCartStore.getState().addItem(draft)
    useCartStore.getState().addItem(draft)
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0]?.quantity).toBe(2)
  })

  it('sépare deux variantes différentes', () => {
    useCartStore
      .getState()
      .addItem(createCartItemDraft(prestige, { variantId: '25cl', optionIds: {} }))
    useCartStore
      .getState()
      .addItem(createCartItemDraft(prestige, { variantId: '50cl', optionIds: {} }))
    expect(useCartStore.getState().items).toHaveLength(2)
  })

  it('sépare deux options différentes', () => {
    useCartStore.getState().addItem(createCartItemDraft(tea, { optionIds: { parfum: 'menthe' } }))
    useCartStore
      .getState()
      .addItem(createCartItemDraft(tea, { optionIds: { parfum: 'fruits-rouges' } }))
    expect(useCartStore.getState().items).toHaveLength(2)
  })

  it('diminue, supprime à zéro et supprime explicitement', () => {
    useCartStore.getState().addItem(createCartItemDraft(burger))
    const lineId = useCartStore.getState().items[0]!.lineId
    useCartStore.getState().incrementItem(lineId)
    useCartStore.getState().decrementItem(lineId)
    expect(useCartStore.getState().items[0]?.quantity).toBe(1)
    useCartStore.getState().removeItem(lineId)
    expect(useCartStore.getState().items).toHaveLength(0)
  })

  it('calcule le total en centimes puis réinitialise la commande', () => {
    useCartStore.getState().addItem(createCartItemDraft(burger))
    useCartStore.getState().addItem(createCartItemDraft(burger))
    expect(getCartTotalCents(useCartStore.getState().items)).toBe(3200)
    useCartStore.getState().clearCart()
    expect(useCartStore.getState().items).toEqual([])
  })
})
