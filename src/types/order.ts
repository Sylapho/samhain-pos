import type { CartItem } from './cart'
import type { TerminalIdentity } from './terminal'

export type PaymentMethod = 'card' | 'cash'
export type OrderNumber = string
export type ReceiptNumber = string
export type PaymentStatus = 'paid'
export type PrintDocumentStatus = 'not_requested' | 'pending' | 'printed' | 'failed' | 'unknown'
export type OrderPrintStatus = 'pending' | 'partial' | 'printed' | 'failed' | 'unknown'

export type OrderIntegrity = {
  algorithm: 'SHA-256'
  journalEntryId: string
  journalSequence: number
  hash: string
}

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
  /** Absent only on orders created before terminal provisioning was introduced. */
  terminal?: TerminalIdentity
  /** Legacy display name retained only while reading pre-provisioning orders. */
  registerName?: string
  paymentMethod: PaymentMethod
  paymentStatus: PaymentStatus
  paidAt: string
  items: CartItem[]
  itemCount: number
  totalCents: number
  createdAt: string
  status: 'confirmed'
  /** Absent only on sales created before the append-only ledger was introduced. */
  integrity?: OrderIntegrity
  printing: OrderPrinting
}
