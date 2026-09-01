import { create } from 'zustand'
import type { CartItem, CartItemDraft } from '../types/cart'

export type CartState = {
  items: CartItem[]
  addItem: (item: CartItemDraft) => void
  incrementItem: (lineId: string) => void
  decrementItem: (lineId: string) => void
  removeItem: (lineId: string) => void
  customizeItem: (lineId: string, removedIngredientIds: string[]) => void
  clearCart: () => void
}

export function getCartLineId(item: CartItemDraft): string {
  const optionKey = [...item.options]
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
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
  customizeItem: (lineId, requestedRemovedIngredientIds) =>
    set((state) => {
      const source = state.items.find((item) => item.lineId === lineId)
      if (!source?.ingredients.length) return state

      const availableIds = new Set(source.ingredients.map((ingredient) => ingredient.id))
      const removedIngredientIds = [...new Set(requestedRemovedIngredientIds)]
        .filter((ingredientId) => availableIds.has(ingredientId))
        .sort()
      const customizedDraft: CartItemDraft = {
        productId: source.productId,
        name: source.name,
        unitPriceCents: source.unitPriceCents,
        variant: source.variant,
        options: source.options,
        ingredients: source.ingredients,
        removedIngredientIds,
        dataConfidence: source.dataConfidence,
        note: source.note,
        vatRate: source.vatRate,
      }
      const customizedLineId = getCartLineId(customizedDraft)
      if (customizedLineId === lineId) return state

      const remainingItems = state.items.flatMap((item) => {
        if (item.lineId !== lineId) return [item]
        return item.quantity > 1 ? [{ ...item, quantity: item.quantity - 1 }] : []
      })
      const existingTarget = remainingItems.find((item) => item.lineId === customizedLineId)
      if (existingTarget) {
        return {
          items: remainingItems.map((item) =>
            item.lineId === customizedLineId ? { ...item, quantity: item.quantity + 1 } : item,
          ),
        }
      }

      return {
        items: [...remainingItems, { ...customizedDraft, lineId: customizedLineId, quantity: 1 }],
      }
    }),
  clearCart: () => set({ items: [] }),
}))
