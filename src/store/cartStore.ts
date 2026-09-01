import { create } from 'zustand'
import type { CartItem } from '../types/cart'
import type { Product } from '../types/catalog'

export type CartState = {
  items: CartItem[]
  addItem: (product: Product) => void
  incrementItem: (productId: string) => void
  decrementItem: (productId: string) => void
  removeItem: (productId: string) => void
  clearCart: () => void
}

export function getCartTotalCents(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0)
}

export function getCartItemCount(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0)
}

export const useCartStore = create<CartState>()((set) => ({
  items: [],
  addItem: (product) => {
    if (product.availability !== 'available') return

    set((state) => {
      const existing = state.items.find((item) => item.productId === product.id)
      if (existing) {
        return {
          items: state.items.map((item) =>
            item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item,
          ),
        }
      }

      return {
        items: [
          ...state.items,
          {
            productId: product.id,
            name: product.name,
            unitPriceCents: product.priceCents,
            quantity: 1,
            priceIsMock: product.priceIsMock,
          },
        ],
      }
    })
  },
  incrementItem: (productId) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.productId === productId ? { ...item, quantity: item.quantity + 1 } : item,
      ),
    })),
  decrementItem: (productId) =>
    set((state) => ({
      items: state.items
        .map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity - 1 } : item,
        )
        .filter((item) => item.quantity > 0),
    })),
  removeItem: (productId) =>
    set((state) => ({ items: state.items.filter((item) => item.productId !== productId) })),
  clearCart: () => set({ items: [] }),
}))
