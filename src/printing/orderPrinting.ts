import type { OrderPrinting, PrintDocumentStatus } from '../types/order'
import { printDocumentTypes, type PrintDocumentType, type PrintSelection } from './types'

export function normalizeOrderPrinting(
  value: Partial<OrderPrinting> | undefined,
  createdAt: string,
): OrderPrinting {
  if (!value) return unknownOrderPrinting(createdAt)

  const pickupTicket = value.pickupTicket ?? 'unknown'
  const printing: OrderPrinting = {
    status: value.status ?? 'unknown',
    pickupTicket,
    customerReceipt: value.customerReceipt ?? 'unknown',
    preparationTicket: value.preparationTicket ?? 'unknown',
    attempts: value.attempts ?? 0,
    updatedAt: value.updatedAt ?? createdAt,
    ...(value.lastError ? { lastError: value.lastError } : {}),
  }
  printing.status = derivePrintStatus(printing)
  if (value.pickupTicket === undefined) {
    printing.lastError = 'État du bon de retrait antérieur inconnu.'
  }
  return printing
}

export function unknownOrderPrinting(createdAt: string): OrderPrinting {
  return {
    status: 'unknown',
    pickupTicket: 'unknown',
    customerReceipt: 'unknown',
    preparationTicket: 'unknown',
    attempts: 0,
    updatedAt: createdAt,
    lastError: 'État d’impression antérieur inconnu.',
  }
}

export function derivePrintStatus(printing: OrderPrinting): OrderPrinting['status'] {
  const requested = printDocumentTypes
    .map((document) => printing[document])
    .filter(
      (status): status is Exclude<PrintDocumentStatus, 'not_requested'> =>
        status !== 'not_requested',
    )
  if (requested.length === 0) return 'printed'
  if (requested.some((status) => status === 'unknown')) return 'unknown'
  if (requested.every((status) => status === 'printed')) return 'printed'
  if (requested.some((status) => status === 'printed')) return 'partial'
  if (requested.some((status) => status === 'pending')) return 'pending'
  return 'failed'
}

export function getRetryableDocuments(printing: OrderPrinting): PrintDocumentType[] {
  return printDocumentTypes.filter((document) => ['pending', 'failed'].includes(printing[document]))
}

export function uniquePrintSelection(selection: PrintSelection): PrintDocumentType[] {
  return printDocumentTypes.filter((document) => selection.includes(document))
}
