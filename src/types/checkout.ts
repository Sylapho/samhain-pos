import type { CartItem } from './cart'
import type { PaymentMethod } from './order'
import type { LedgerSource } from './salesLedger'
import type { TerminalIdentity } from './terminal'

/**
 * Durable checkout state. Only `finalized` represents a sale; every earlier state
 * exists so an external payment can be resumed or verified without guessing.
 */
export type CheckoutIntentStatus =
  'pending_payment' | 'payment_to_verify' | 'payment_confirmed' | 'finalized' | 'abandoned'

export type CheckoutIntent = {
  id: string
  cartSnapshot: CartItem[]
  itemCount: number
  totalCents: number
  paymentMethod: PaymentMethod
  status: CheckoutIntentStatus
  terminal: TerminalIdentity
  ledgerSource: LedgerSource
  orderNumberPrefix: string
  receiptNumberPrefix: string
  printCustomerReceipt: boolean
  createdAt: string
  updatedAt: string
  paymentConfirmedAt?: string
  finalizedOrderId?: string
  abandonedAt?: string
}

export type CheckoutIntentCreationRequest = Omit<
  CheckoutIntent,
  'status' | 'updatedAt' | 'paymentConfirmedAt' | 'finalizedOrderId' | 'abandonedAt'
>
