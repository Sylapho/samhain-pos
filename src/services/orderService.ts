import { posConfig } from '../config/pos'
import { getCartItemCount, getCartTotalCents } from '../store/cartStore'
import type { CartItem } from '../types/cart'
import type { PrintDocumentType, PrintSelection } from '../printing/types'
import type {
  Order,
  OrderNumber,
  OrderPrinting,
  PaymentMethod,
  ReceiptNumber,
} from '../types/order'
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

function normalizeOrder(order: Order): Order {
  if (order.printing && order.paymentStatus) return order
  return {
    ...order,
    paymentStatus: 'paid',
    paidAt: order.createdAt,
    printing: {
      status: 'unknown',
      customerReceipt: 'unknown',
      preparationTicket: 'unknown',
      attempts: 0,
      updatedAt: order.createdAt,
      lastError: 'État d’impression antérieur inconnu.',
    },
  }
}

function selectedDocuments(selection: PrintSelection): PrintDocumentType[] {
  if (selection === 'customer') return ['customerReceipt']
  if (selection === 'preparation') return ['preparationTicket']
  return ['customerReceipt', 'preparationTicket']
}

function derivePrintStatus(printing: OrderPrinting): OrderPrinting['status'] {
  const states = [printing.customerReceipt, printing.preparationTicket].filter(
    (status) => status !== 'not_requested',
  )
  if (states.some((status) => status === 'unknown')) return 'unknown'
  if (states.every((status) => status === 'printed')) return 'printed'
  if (states.some((status) => status === 'printed')) return 'partial'
  if (states.some((status) => status === 'pending')) return 'pending'
  return 'failed'
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
    printCustomerReceipt = true,
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
      paymentStatus: 'paid',
      paidAt: createdAtIso,
      items: persistedItems,
      itemCount,
      totalCents,
      createdAt: createdAtIso,
      status: 'confirmed',
      printing: {
        status: 'pending',
        customerReceipt: printCustomerReceipt ? 'pending' : 'not_requested',
        preparationTicket: 'pending',
        attempts: 0,
        updatedAt: createdAtIso,
      },
    }))
  }

  getOrders(): Promise<Order[]> {
    return this.repository.getOrders().then((orders) =>
      orders.map((storedOrder) => {
        const order = normalizeOrder(storedOrder)
        return { ...order, items: cloneCartItems(order.items) }
      }),
    )
  }

  getRecoverableOrders(): Promise<Order[]> {
    return this.getOrders().then((orders) =>
      orders
        .filter((order) => order.paymentStatus === 'paid' && order.printing.status !== 'printed')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    )
  }

  beginPrinting(
    orderId: string,
    selection: PrintSelection,
    updatedAt = new Date(),
  ): Promise<Order> {
    return this.updatePrinting(orderId, (printing) => {
      const next = {
        ...printing,
        attempts: printing.attempts + 1,
        updatedAt: updatedAt.toISOString(),
      }
      for (const document of selectedDocuments(selection)) {
        // A process termination after USB transfer must require checking the paper output.
        if (!['not_requested', 'printed'].includes(next[document])) next[document] = 'unknown'
      }
      next.status = derivePrintStatus(next)
      delete next.lastError
      return next
    })
  }

  completePrinting(
    orderId: string,
    selection: PrintSelection,
    completedDocuments: PrintDocumentType[],
    updatedAt = new Date(),
  ): Promise<Order> {
    return this.updatePrinting(orderId, (printing) => {
      const next = { ...printing, updatedAt: updatedAt.toISOString() }
      for (const document of selectedDocuments(selection)) {
        if (['not_requested', 'printed'].includes(next[document])) continue
        next[document] = completedDocuments.includes(document) ? 'printed' : 'failed'
      }
      next.status = derivePrintStatus(next)
      delete next.lastError
      return next
    })
  }

  failPrinting(
    orderId: string,
    selection: PrintSelection,
    completedDocuments: PrintDocumentType[],
    message: string,
    updatedAt = new Date(),
  ): Promise<Order> {
    return this.updatePrinting(orderId, (printing) => {
      const next = { ...printing, updatedAt: updatedAt.toISOString(), lastError: message }
      for (const document of selectedDocuments(selection)) {
        if (['not_requested', 'printed'].includes(next[document])) continue
        next[document] = completedDocuments.includes(document) ? 'printed' : 'failed'
      }
      next.status = derivePrintStatus(next)
      return next
    })
  }

  private updatePrinting(
    orderId: string,
    update: (printing: OrderPrinting) => OrderPrinting,
  ): Promise<Order> {
    return this.repository.updateOrder(orderId, (storedOrder) => {
      const order = normalizeOrder(storedOrder)
      return { ...order, printing: update(order.printing) }
    })
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
  printCustomerReceipt = true,
): Promise<Order> {
  return getDefaultOrderService().createOrder(items, paymentMethod, createdAt, printCustomerReceipt)
}

export function getPersistedOrders(): Promise<Order[]> {
  return getDefaultOrderService().getOrders()
}

export function getRecoverableOrders(): Promise<Order[]> {
  return getDefaultOrderService().getRecoverableOrders()
}

export const orderLifecycle = {
  beginPrinting: (orderId: string, selection: PrintSelection) =>
    getDefaultOrderService().beginPrinting(orderId, selection),
  completePrinting: (
    orderId: string,
    selection: PrintSelection,
    completedDocuments: PrintDocumentType[],
  ) => getDefaultOrderService().completePrinting(orderId, selection, completedDocuments),
  failPrinting: (
    orderId: string,
    selection: PrintSelection,
    completedDocuments: PrintDocumentType[],
    message: string,
  ) => getDefaultOrderService().failPrinting(orderId, selection, completedDocuments, message),
}
