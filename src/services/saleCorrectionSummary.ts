import type { Order } from '../types/order'
import type { CorrectionLedgerEntry } from '../types/salesLedger'
import { deriveRefundAvailability, type RefundableOrderLine } from './saleRefund'

export type SaleCorrectionStatus = 'active' | 'partially-refunded' | 'refunded' | 'cancelled'

export type SaleCorrectionSummary = {
  status: SaleCorrectionStatus
  refundedAmountCents: number
  correctionDeltaCents: number
  remainingRefundableCents: number
  canCancel: boolean
  canRefund: boolean
  refundableLines: RefundableOrderLine[]
  hasLegacyAmountOnlyRefund: boolean
}

export const saleCorrectionStatusLabels: Record<SaleCorrectionStatus, string> = {
  active: 'Active',
  'partially-refunded': 'Partiellement remboursée',
  refunded: 'Remboursée',
  cancelled: 'Annulée',
}

export function deriveSaleCorrectionSummary(
  order: Pick<Order, 'id' | 'totalCents' | 'items'>,
  corrections: CorrectionLedgerEntry[],
): SaleCorrectionSummary {
  const relatedCorrections = corrections.filter(
    (entry) => entry.correction.originalOrderId === order.id,
  )
  const cancelled = relatedCorrections.some((entry) => entry.correction.type === 'cancellation')
  const availability = deriveRefundAvailability(order, relatedCorrections)
  const refundedAmountCents = relatedCorrections
    .filter((entry) => entry.correction.type === 'refund')
    .reduce((total, entry) => total - entry.correction.amountDeltaCents, 0)
  const remainingRefundableCents = cancelled
    ? 0
    : Math.max(0, order.totalCents - refundedAmountCents)
  const status: SaleCorrectionStatus = cancelled
    ? 'cancelled'
    : remainingRefundableCents === 0 && refundedAmountCents > 0
      ? 'refunded'
      : refundedAmountCents > 0
        ? 'partially-refunded'
        : 'active'

  return {
    status,
    refundedAmountCents,
    correctionDeltaCents: relatedCorrections.reduce(
      (total, entry) => total + entry.correction.amountDeltaCents,
      0,
    ),
    remainingRefundableCents,
    canCancel: !cancelled && relatedCorrections.length === 0,
    canRefund:
      !cancelled &&
      !availability.hasLegacyAmountOnlyRefund &&
      availability.lines.some((line) => line.remainingQuantity > 0),
    refundableLines: availability.lines,
    hasLegacyAmountOnlyRefund: availability.hasLegacyAmountOnlyRefund,
  }
}
