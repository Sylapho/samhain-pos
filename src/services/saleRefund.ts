import type { Order } from '../types/order'
import type { CorrectionLedgerEntry, RefundLine, RefundLineSelection } from '../types/salesLedger'
import { calculateIncludedVatCents } from '../utils/vat'
import { canonicalJson } from '../utils/integrity'

export type RefundableOrderLine = {
  originalLineId: string
  productId: string
  productName: string
  soldQuantity: number
  refundedQuantity: number
  remainingQuantity: number
  unitPriceCents: number
  vatRate: number
}

export type RefundAvailability = {
  lines: RefundableOrderLine[]
  hasLegacyAmountOnlyRefund: boolean
}

export function buildRefundLines(
  order: Pick<Order, 'id' | 'items'>,
  selections: RefundLineSelection[],
  corrections: CorrectionLedgerEntry[] = [],
): RefundLine[] {
  if (selections.length === 0) throw new Error('Sélectionnez au moins un article à rembourser.')
  const byLineId = new Map(order.items.map((item) => [item.lineId, item]))
  const seen = new Set<string>()
  return selections.map((selection) => {
    if (!selection.originalLineId.trim() || seen.has(selection.originalLineId)) {
      throw new Error('Chaque ligne de remboursement doit être unique et identifiable.')
    }
    seen.add(selection.originalLineId)
    if (!Number.isSafeInteger(selection.quantity) || selection.quantity <= 0) {
      throw new Error('La quantité remboursée doit être un entier strictement positif.')
    }
    const original = byLineId.get(selection.originalLineId)
    if (!original) throw new Error(`Ligne originale ${selection.originalLineId} introuvable.`)
    if (selection.quantity > original.quantity) {
      throw new Error(`La quantité demandée dépasse la quantité vendue pour « ${original.name} ».`)
    }
    const grossCents = original.unitPriceCents * selection.quantity
    const previouslyRefundedQuantity = corrections
      .filter(
        (entry) =>
          entry.correction.originalOrderId === order.id && entry.correction.type === 'refund',
      )
      .flatMap((entry) => entry.correction.refundLines ?? [])
      .filter((line) => line.originalLineId === original.lineId)
      .reduce((total, line) => total + line.quantity, 0)
    const previousRefundedGrossCents = original.unitPriceCents * previouslyRefundedQuantity
    const cumulativeRefundedGrossCents = previousRefundedGrossCents + grossCents
    return {
      originalLineId: original.lineId,
      productId: original.productId,
      productName: original.name,
      quantity: selection.quantity,
      unitPriceCents: original.unitPriceCents,
      vatRate: original.vatRate,
      grossCents,
      vatCents:
        calculateIncludedVatCents(cumulativeRefundedGrossCents, original.vatRate) -
        calculateIncludedVatCents(previousRefundedGrossCents, original.vatRate),
    }
  })
}

export function deriveRefundAvailability(
  order: Pick<Order, 'id' | 'items'>,
  corrections: CorrectionLedgerEntry[],
): RefundAvailability {
  const refunds = corrections.filter(
    (entry) => entry.correction.originalOrderId === order.id && entry.correction.type === 'refund',
  )
  const hasLegacyAmountOnlyRefund = refunds.some((entry) => !entry.correction.refundLines)
  const refundedByLine = new Map<string, number>()
  for (const refund of refunds) {
    for (const line of refund.correction.refundLines ?? []) {
      refundedByLine.set(
        line.originalLineId,
        (refundedByLine.get(line.originalLineId) ?? 0) + line.quantity,
      )
    }
  }
  return {
    hasLegacyAmountOnlyRefund,
    lines: order.items.map((item) => {
      const refundedQuantity = refundedByLine.get(item.lineId) ?? 0
      return {
        originalLineId: item.lineId,
        productId: item.productId,
        productName: item.name,
        soldQuantity: item.quantity,
        refundedQuantity,
        remainingQuantity: Math.max(0, item.quantity - refundedQuantity),
        unitPriceCents: item.unitPriceCents,
        vatRate: item.vatRate,
      }
    }),
  }
}

export function validateStructuredRefund(
  order: Pick<Order, 'id' | 'items'>,
  corrections: CorrectionLedgerEntry[],
  requestedLines: RefundLine[] | undefined,
): RefundLine[] {
  if (!requestedLines?.length) {
    throw new Error('Les lignes du remboursement sont obligatoires.')
  }
  const availability = deriveRefundAvailability(order, corrections)
  if (availability.hasLegacyAmountOnlyRefund) {
    throw new Error(
      'Cette vente contient un ancien remboursement sans détail de lignes. Un nouveau remboursement par article est impossible sans inventer les quantités restantes.',
    )
  }
  const canonical = buildRefundLines(
    order,
    requestedLines.map(({ originalLineId, quantity }) => ({ originalLineId, quantity })),
    corrections,
  )
  for (let index = 0; index < canonical.length; index += 1) {
    const expected = canonical[index]!
    const requested = requestedLines[index]!
    if (canonicalJson(requested) !== canonicalJson(expected)) {
      throw new Error('Les montants du remboursement ne correspondent pas à la vente originale.')
    }
    const remaining = availability.lines.find(
      (line) => line.originalLineId === requested.originalLineId,
    )?.remainingQuantity
    if (remaining === undefined || requested.quantity > remaining) {
      throw new Error(
        `La quantité remboursable restante est insuffisante pour « ${requested.productName} ».`,
      )
    }
  }
  return canonical
}

export function refundLinesTotalCents(lines: RefundLine[]): number {
  return lines.reduce((total, line) => total + line.grossCents, 0)
}
