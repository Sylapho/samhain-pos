import { posConfig } from '../config/pos'
import { getCartItemCount, getCartTotalCents } from '../store/cartStore'
import type { CartItem } from '../types/cart'
import type { Order, OrderNumber, PaymentMethod, ReceiptNumber } from '../types/order'
import { IndexedDbOrderRepository, type OrderRepository } from './orderRepository'

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

function cloneCartItems(items: CartItem[]): CartItem[] {
  return items.map((item) => ({
    ...item,
    options: item.options.map((option) => ({ ...option })),
    ingredients: item.ingredients.map((ingredient) => ({ ...ingredient })),
    removedIngredientIds: [...item.removedIngredientIds],
    variant: item.variant ? { ...item.variant } : undefined,
  }))
}

export class OrderService {
  constructor(
    private readonly repository: OrderRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  createOrder(
    items: CartItem[],
    paymentMethod: PaymentMethod,
    createdAt = new Date(),
  ): Promise<Order> {
    const persistedItems = cloneCartItems(items)
    const itemCount = getCartItemCount(persistedItems)
    const totalCents = getCartTotalCents(persistedItems)
    const createdAtIso = createdAt.toISOString()

    return this.repository.createOrder(({ orderSequence, receiptSequence }) => ({
      id: this.createId(),
      orderNumber: formatOrderNumber(orderSequence),
      receiptNumber: formatReceiptNumber(createdAt, receiptSequence),
      registerName: posConfig.registerName,
      paymentMethod,
      items: persistedItems,
      itemCount,
      totalCents,
      createdAt: createdAtIso,
      status: 'confirmed',
    }))
  }

  getOrders(): Promise<Order[]> {
    return this.repository.getOrders().then((orders) =>
      orders.map((order) => ({
        ...order,
        items: cloneCartItems(order.items),
      })),
    )
  }
}

let defaultOrderService: OrderService | null = null

function getDefaultOrderService(): OrderService {
  if (!defaultOrderService) {
    if (!globalThis.indexedDB) {
      throw new Error('Le stockage local durable IndexedDB est indisponible sur cet appareil.')
    }
    defaultOrderService = new OrderService(new IndexedDbOrderRepository(globalThis.indexedDB))
  }
  return defaultOrderService
}

export function createOrder(
  items: CartItem[],
  paymentMethod: PaymentMethod,
  createdAt = new Date(),
): Promise<Order> {
  return getDefaultOrderService().createOrder(items, paymentMethod, createdAt)
}

export function getPersistedOrders(): Promise<Order[]> {
  return getDefaultOrderService().getOrders()
}
