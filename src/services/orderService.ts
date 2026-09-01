import { posConfig } from '../config/pos'
import { getCartItemCount, getCartTotalCents } from '../store/cartStore'
import type { CartItem } from '../types/cart'
import type { Order, OrderNumber, PaymentMethod, ReceiptNumber } from '../types/order'

let nextOrderSequence = 1
let nextReceiptSequence = 1

export function formatOrderNumber(sequence: number): OrderNumber {
  return `A${String(sequence).padStart(3, '0')}`
}

export function formatReceiptNumber(date: Date, sequence: number): ReceiptNumber {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: posConfig.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `R-${value('year')}${value('month')}${value('day')}-${String(sequence).padStart(4, '0')}`
}

export function createMockOrder(
  items: CartItem[],
  paymentMethod: PaymentMethod,
  createdAt = new Date(),
): Order {
  const orderSequence = nextOrderSequence++
  const receiptSequence = nextReceiptSequence++
  return {
    id: `mock-order-${orderSequence}`,
    orderNumber: formatOrderNumber(orderSequence),
    receiptNumber: formatReceiptNumber(createdAt, receiptSequence),
    registerName: posConfig.registerName,
    paymentMethod,
    items: items.map((item) => ({
      ...item,
      options: item.options.map((option) => ({ ...option })),
      ingredients: item.ingredients.map((ingredient) => ({ ...ingredient })),
      removedIngredientIds: [...item.removedIngredientIds],
      variant: item.variant ? { ...item.variant } : undefined,
    })),
    itemCount: getCartItemCount(items),
    totalCents: getCartTotalCents(items),
    createdAt: createdAt.toISOString(),
    status: 'confirmed',
  }
}

export function resetMockOrderSequenceForTests(): void {
  nextOrderSequence = 1
  nextReceiptSequence = 1
}
