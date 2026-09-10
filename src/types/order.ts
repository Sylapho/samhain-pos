import type { CartItem } from './cart'

export type PaymentMethod = 'card' | 'cash'
export type OrderNumber = string
export type ReceiptNumber = string
export type PaymentStatus = 'paid'
export type PrintDocumentStatus = 'not_requested' | 'pending' | 'printed' | 'failed' | 'unknown'
export type OrderPrintStatus = 'pending' | 'partial' | 'printed' | 'failed' | 'unknown'

export type OrderPrinting = {
  status: OrderPrintStatus
  customerReceipt: PrintDocumentStatus
  preparationTicket: PrintDocumentStatus
  attempts: number
  updatedAt: string
  lastError?: string
}

export type Order = {
  id: string
  orderNumber: OrderNumber
  receiptNumber: ReceiptNumber
  registerName: string
  paymentMethod: PaymentMethod
  paymentStatus: PaymentStatus
  paidAt: string
  items: CartItem[]
  itemCount: number
  totalCents: number
  createdAt: string
  status: 'confirmed'
  printing: OrderPrinting
}
