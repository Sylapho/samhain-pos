import { create } from 'zustand'
import type { CartItem, CartItemDraft } from '../types/cart'

export type CartState = {
  items: CartItem[]
  addItem: (item: CartItemDraft) => void
  incrementItem: (lineId: string) => void
  decrementItem: (lineId: string) => void
  removeItem: (lineId: string) => void
  clearCart: () => void
}

export function getCartLineId(item: CartItemDraft): string {
  const optionKey = [...item.options]
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
    .map((option) => `${option.groupId}:${option.optionId}`)
    .join('|')
  return [item.productId, item.variant?.id ?? '', optionKey].join('::')
}

export function getCartTotalCents(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0)
}

export function getCartItemCount(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0)
}

export const useCartStore = create<CartState>()((set) => ({
  items: [],
  addItem: (draft) => {
    const lineId = getCartLineId(draft)
    set((state) => {
      if (state.items.some((item) => item.lineId === lineId)) {
        return {
          items: state.items.map((item) =>
            item.lineId === lineId ? { ...item, quantity: item.quantity + 1 } : item,
          ),
        }
      }
      return { items: [...state.items, { ...draft, lineId, quantity: 1 }] }
    })
  },
  incrementItem: (lineId) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.lineId === lineId ? { ...item, quantity: item.quantity + 1 } : item,
      ),
    })),
  decrementItem: (lineId) =>
    set((state) => ({
      items: state.items
        .map((item) => (item.lineId === lineId ? { ...item, quantity: item.quantity - 1 } : item))
        .filter((item) => item.quantity > 0),
    })),
  removeItem: (lineId) =>
    set((state) => ({ items: state.items.filter((item) => item.lineId !== lineId) })),
  clearCart: () => set({ items: [] }),
}))
