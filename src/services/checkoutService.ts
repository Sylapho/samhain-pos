import { posConfig } from '../config/pos'
import type { CartItem } from '../types/cart'
import type { CheckoutIntent } from '../types/checkout'
import type { Order, PaymentMethod } from '../types/order'
import type { TerminalCode, TerminalConfiguration } from '../types/terminal'
import type { CheckoutRepository } from './orderRepository'
import { getOrderDataRepository } from './orderRepositoryFactory'
import { createLedgerSource } from './ledgerSource'
import { getRequiredTerminalConfiguration } from './terminalConfigurationService'
import {
  toIsoTimestamp,
  validateCheckoutIntent,
  validateOrderDraft,
  validateTerminalConfiguration,
} from './orderValidation'

function receiptNumberPrefix(terminalCode: TerminalCode, date: Date): string {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: posConfig.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `R-${terminalCode}-${value('year')}${value('month')}${value('day')}`
}

export class CheckoutService {
  constructor(
    private readonly repository: CheckoutRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
    private readonly loadTerminalConfiguration: () => TerminalConfiguration = getRequiredTerminalConfiguration,
    private readonly buildLedgerSource = createLedgerSource,
  ) {}

  createIntent(
    items: CartItem[],
    paymentMethod: PaymentMethod,
    printCustomerReceipt: boolean = posConfig.defaultPrintCustomerReceipt,
    createdAt = new Date(),
  ): Promise<CheckoutIntent> {
    const createdAtIso = toIsoTimestamp(createdAt, 'La date de création')
    const terminal = validateTerminalConfiguration(this.loadTerminalConfiguration())
    const snapshot = validateOrderDraft({
      id: this.createId(),
      terminal,
      paymentMethod,
      paymentStatus: 'paid',
      paidAt: createdAtIso,
      items,
      createdAt: createdAtIso,
      status: 'confirmed',
    })
    const intent = validateCheckoutIntent({
      id: snapshot.id,
      cartSnapshot: snapshot.items,
      itemCount: snapshot.itemCount,
      totalCents: snapshot.totalCents,
      paymentMethod: snapshot.paymentMethod,
      status: 'pending_payment',
      terminal: snapshot.terminal,
      ledgerSource: this.buildLedgerSource(snapshot.terminal),
      orderNumberPrefix: snapshot.terminal.terminalCode,
      receiptNumberPrefix: receiptNumberPrefix(snapshot.terminal.terminalCode, createdAt),
      printCustomerReceipt,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
    })
    return this.repository.createCheckoutIntent(intent)
  }

  beginPayment(id: string, updatedAt = new Date()): Promise<CheckoutIntent> {
    return this.repository.markCheckoutPaymentToVerify(
      id,
      toIsoTimestamp(updatedAt, 'La date de début du paiement'),
    )
  }

  confirmPayment(id: string, confirmedAt = new Date()): Promise<CheckoutIntent> {
    return this.repository.confirmCheckoutPayment(
      id,
      toIsoTimestamp(confirmedAt, 'La date de confirmation du paiement'),
    )
  }

  abandon(id: string, abandonedAt = new Date()): Promise<CheckoutIntent> {
    return this.repository.abandonCheckoutIntent(
      id,
      toIsoTimestamp(abandonedAt, "La date d'abandon du paiement"),
    )
  }

  finalize(id: string, updatedAt = new Date()): Promise<Order> {
    return this.repository.finalizeCheckoutIntent(
      id,
      toIsoTimestamp(updatedAt, 'La date de finalisation'),
    )
  }

  async getRecoverableIntents(): Promise<CheckoutIntent[]> {
    return (await this.repository.getCheckoutIntents())
      .filter((intent) => !['finalized', 'abandoned'].includes(intent.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }
}

let defaultCheckoutService: CheckoutService | null = null

function getDefaultCheckoutService(): CheckoutService {
  defaultCheckoutService ??= new CheckoutService(getOrderDataRepository())
  return defaultCheckoutService
}

export const checkoutService = {
  createIntent: (
    items: CartItem[],
    paymentMethod: PaymentMethod,
    printCustomerReceipt: boolean = posConfig.defaultPrintCustomerReceipt,
  ) => getDefaultCheckoutService().createIntent(items, paymentMethod, printCustomerReceipt),
  beginPayment: (id: string) => getDefaultCheckoutService().beginPayment(id),
  confirmPayment: (id: string) => getDefaultCheckoutService().confirmPayment(id),
  abandon: (id: string) => getDefaultCheckoutService().abandon(id),
  finalize: (id: string) => getDefaultCheckoutService().finalize(id),
  getRecoverableIntents: () => getDefaultCheckoutService().getRecoverableIntents(),
}
