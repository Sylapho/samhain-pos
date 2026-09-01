import { getCartItemCount, getCartTotalCents } from '../store/cartStore'
import type { CartItem } from '../types/cart'
import type { Order } from '../types/order'

let nextMockOrderNumber = 42

export function createMockOrder(items: CartItem[]): Order {
  const sequence = nextMockOrderNumber++
  return {
    id: `mock-order-${sequence}`,
    orderNumber: `#${String(sequence).padStart(3, '0')}`,
    items: items.map((item) => ({
      ...item,
      options: item.options.map((option) => ({ ...option })),
      variant: item.variant ? { ...item.variant } : undefined,
    })),
    itemCount: getCartItemCount(items),
    totalCents: getCartTotalCents(items),
    createdAt: new Date().toISOString(),
    status: 'confirmed',
  }
}

export function resetMockOrderSequenceForTests(): void {
  nextMockOrderNumber = 42
}
