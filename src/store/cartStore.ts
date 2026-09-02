import { create } from 'zustand'
import type { CartItem, CartItemDraft } from '../types/cart'

export type CartState = {
  items: CartItem[]
  addItem: (item: CartItemDraft) => void
  incrementItem: (lineId: string) => void
  decrementItem: (lineId: string) => void
  removeItem: (lineId: string) => void
  configureItem: (lineId: string, configuredItem: CartItemDraft) => void
  clearCart: () => void
}

export function getCartLineId(item: CartItemDraft): string {
  const optionKey = [...item.options]
    .sort(
      (left, right) =>
        left.groupId.localeCompare(right.groupId) || left.optionId.localeCompare(right.optionId),
    )
    .map((option) => `${option.groupId}:${option.optionId}`)
    .join('|')
  const removedIngredientKey = [...item.removedIngredientIds].sort().join('|')
  return [item.productId, item.variant?.id ?? '', optionKey, removedIngredientKey].join('::')
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
  configureItem: (lineId, configuredItem) =>
    set((state) => {
      const source = state.items.find((item) => item.lineId === lineId)
      if (!source || source.productId !== configuredItem.productId) return state

      const configuredLineId = getCartLineId(configuredItem)
      if (configuredLineId === lineId && source.unitPriceCents === configuredItem.unitPriceCents) {
        return state
      }

      const remainingItems = state.items.flatMap((item) => {
        if (item.lineId !== lineId) return [item]
        return item.quantity > 1 ? [{ ...item, quantity: item.quantity - 1 }] : []
      })
      const existingTarget = remainingItems.find((item) => item.lineId === configuredLineId)
      if (existingTarget) {
        return {
          items: remainingItems.map((item) =>
            item.lineId === configuredLineId ? { ...item, quantity: item.quantity + 1 } : item,
          ),
        }
      }

      return {
        items: [...remainingItems, { ...configuredItem, lineId: configuredLineId, quantity: 1 }],
      }
    }),
  clearCart: () => set({ items: [] }),
}))
