import { beforeEach, describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import { getCartTotalCents, useCartStore } from './cartStore'

const burger = products.find((p) => p.id === 'burger-samhain')!
const soldOut = products.find((p) => p.id === 'merguez-frites')!

describe('cart store', () => {
  beforeEach(() => useCartStore.getState().clearCart())
  it('ajoute puis incrémente un produit', () => { useCartStore.getState().addItem(burger); useCartStore.getState().addItem(burger); expect(useCartStore.getState().items[0]?.quantity).toBe(2) })
  it('diminue puis supprime à zéro', () => { useCartStore.getState().addItem(burger); useCartStore.getState().incrementItem(burger.id); useCartStore.getState().decrementItem(burger.id); expect(useCartStore.getState().items[0]?.quantity).toBe(1); useCartStore.getState().decrementItem(burger.id); expect(useCartStore.getState().items).toHaveLength(0) })
  it('supprime explicitement', () => { useCartStore.getState().addItem(burger); useCartStore.getState().removeItem(burger.id); expect(useCartStore.getState().items).toHaveLength(0) })
  it('calcule le total', () => { useCartStore.getState().addItem(burger); useCartStore.getState().addItem(burger); expect(getCartTotalCents(useCartStore.getState().items)).toBe(3200) })
  it('refuse un produit épuisé', () => { useCartStore.getState().addItem(soldOut); expect(useCartStore.getState().items).toHaveLength(0) })
})
