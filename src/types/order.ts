import type { CartItem } from './cart'

export type Order = {
  id: string
  orderNumber: string
  items: CartItem[]
  itemCount: number
  totalCents: number
  createdAt: string
  status: 'confirmed'
}
