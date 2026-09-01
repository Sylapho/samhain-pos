import type { CartItem } from './cart'

export type PaymentMethod = 'card' | 'cash'
export type OrderNumber = string
export type ReceiptNumber = string

export type Order = {
  id: string
  orderNumber: OrderNumber
  receiptNumber: ReceiptNumber
  registerName: string
  paymentMethod: PaymentMethod
  items: CartItem[]
  itemCount: number
  totalCents: number
  createdAt: string
  status: 'confirmed'
}
