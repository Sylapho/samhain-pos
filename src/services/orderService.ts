import { posConfig } from '../config/pos'
import type { CartItem } from '../types/cart'
import type { PrintDocumentType, PrintSelection } from '../printing/types'
import type {
  Order,
  OrderNumber,
  OrderPrinting,
  PaymentMethod,
  ReceiptNumber,
} from '../types/order'
import type { TerminalCode, TerminalConfiguration } from '../types/terminal'
import type { OrderRepository } from './orderRepository'
import { getOrderDataRepository } from './orderRepositoryFactory'
import { createLedgerSource } from './ledgerSource'
import { getRequiredTerminalConfiguration } from './terminalConfigurationService'
import { orderRequiresPreparation } from '../utils/preparation'
import { orderRequiresPickupTicket } from '../utils/preparation'
import {
  derivePrintStatus,
  normalizeOrderPrinting,
  uniquePrintSelection,
} from '../printing/orderPrinting'
import {
  toIsoTimestamp,
  validateOrderDraft,
  validateTerminalConfiguration,
} from './orderValidation'

export function formatOrderNumber(terminalCode: TerminalCode, sequence: number): OrderNumber {
  return `${terminalCode}-${String(sequence).padStart(4, '0')}`
}

export function formatReceiptNumber(
  terminalCode: TerminalCode,
  date: Date,
  sequence: number,
): ReceiptNumber {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: posConfig.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `R-${terminalCode}-${value('year')}${value('month')}${value('day')}-${String(sequence).padStart(4, '0')}`
}

function receiptNumberPrefix(terminalCode: TerminalCode, date: Date): string {
  return formatReceiptNumber(terminalCode, date, 0).replace(/-0000$/, '')
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
  return {
    ...order,
    paymentStatus: order.paymentStatus ?? 'paid',
    paidAt: order.paidAt ?? order.createdAt,
    printing: normalizeOrderPrinting(order.printing, order.createdAt),
  }
}

function selectedDocuments(selection: PrintSelection): PrintDocumentType[] {
  return uniquePrintSelection(selection)
}

function initialPrinting(
  items: CartItem[],
  printCustomerReceipt: boolean,
  updatedAt: string,
): OrderPrinting {
  const printing: OrderPrinting = {
    status: 'pending',
    pickupTicket: orderRequiresPickupTicket({ items }) ? 'pending' : 'not_requested',
    customerReceipt: printCustomerReceipt ? 'pending' : 'not_requested',
    preparationTicket: orderRequiresPreparation({ items }) ? 'pending' : 'not_requested',
    attempts: 0,
    updatedAt,
  }
  printing.status = derivePrintStatus(printing)
  return printing
}

export class OrderService {
  constructor(
    private readonly repository: OrderRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
    private readonly loadTerminalConfiguration: () => TerminalConfiguration = getRequiredTerminalConfiguration,
    private readonly buildLedgerSource = createLedgerSource,
  ) {}

  createOrder(
    items: CartItem[],
    paymentMethod: PaymentMethod,
    createdAt = new Date(),
    printCustomerReceipt: boolean = posConfig.defaultPrintCustomerReceipt,
  ): Promise<Order> {
    const createdAtIso = toIsoTimestamp(createdAt, 'La date de création')
    const terminalConfiguration = validateTerminalConfiguration(this.loadTerminalConfiguration())
    const validated = validateOrderDraft({
      id: this.createId(),
      terminal: terminalConfiguration,
      paymentMethod,
      paymentStatus: 'paid',
      paidAt: createdAtIso,
      items,
      createdAt: createdAtIso,
      status: 'confirmed',
    })
    const persistedItems = cloneCartItems(validated.items)

    return this.repository.createOrder(
      {
        ...validated,
        orderNumberPrefix: validated.terminal.terminalCode,
        receiptNumberPrefix: receiptNumberPrefix(validated.terminal.terminalCode, createdAt),
        items: persistedItems,
        printing: initialPrinting(persistedItems, printCustomerReceipt, createdAtIso),
      },
      this.buildLedgerSource(validated.terminal),
    )
  }

  getOrders(): Promise<Order[]> {
    return this.repository.getOrders().then((orders) =>
      orders
        .map((storedOrder) => {
          const order = normalizeOrder(storedOrder)
          return { ...order, items: cloneCartItems(order.items) }
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
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
    unknownDocumentsOrUpdatedAt: PrintDocumentType[] | Date = [],
    updatedAt = new Date(),
  ): Promise<Order> {
    const unknownDocuments =
      unknownDocumentsOrUpdatedAt instanceof Date ? [] : unknownDocumentsOrUpdatedAt
    const effectiveUpdatedAt =
      unknownDocumentsOrUpdatedAt instanceof Date ? unknownDocumentsOrUpdatedAt : updatedAt
    return this.updatePrinting(orderId, (printing) => {
      const next = { ...printing, updatedAt: effectiveUpdatedAt.toISOString(), lastError: message }
      for (const document of selectedDocuments(selection)) {
        if (['not_requested', 'printed'].includes(next[document])) continue
        next[document] = completedDocuments.includes(document)
          ? 'printed'
          : unknownDocuments.includes(document)
            ? 'unknown'
            : 'failed'
      }
      next.status = derivePrintStatus(next)
      return next
    })
  }

  private updatePrinting(
    orderId: string,
    update: (printing: OrderPrinting) => OrderPrinting,
  ): Promise<Order> {
    return this.repository.updateOrderPrinting(orderId, update)
  }
}

let defaultOrderService: OrderService | null = null

function getDefaultOrderService(): OrderService {
  if (!defaultOrderService) {
    defaultOrderService = new OrderService(getOrderDataRepository())
  }
  return defaultOrderService
}

export function createOrder(
  items: CartItem[],
  paymentMethod: PaymentMethod,
  createdAt = new Date(),
  printCustomerReceipt: boolean = posConfig.defaultPrintCustomerReceipt,
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
    unknownDocuments: PrintDocumentType[] = [],
  ) =>
    getDefaultOrderService().failPrinting(
      orderId,
      selection,
      completedDocuments,
      message,
      unknownDocuments,
    ),
}
