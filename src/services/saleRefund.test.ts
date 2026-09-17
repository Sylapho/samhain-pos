import { describe, expect, it } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import type { CorrectionLedgerEntry, RefundLine } from '../types/salesLedger'
import {
  buildRefundLines,
  deriveRefundAvailability,
  refundLinesTotalCents,
  validateStructuredRefund,
} from './saleRefund'

function refund(lines: RefundLine[] | undefined, amountDeltaCents: number): CorrectionLedgerEntry {
  return {
    schemaVersion: 1,
    id: `refund:${amountDeltaCents}`,
    sequence: 2,
    recordedAt: '2026-09-01T19:00:00.000Z',
    previousHash: 'previous',
    hash: 'hash',
    kind: 'correction',
    source: {
      softwareVersion: 'test',
      buildMode: 'test',
      terminal: printPreviewOrder.terminal!,
      organization: {} as CorrectionLedgerEntry['source']['organization'],
    },
    correction: {
      operationId: `operation:${amountDeltaCents}`,
      originalOrderId: printPreviewOrder.id,
      originalOrderNumber: printPreviewOrder.orderNumber,
      originalReceiptNumber: printPreviewOrder.receiptNumber,
      type: 'refund',
      reason: 'Test',
      amountDeltaCents,
      paymentMethod: printPreviewOrder.paymentMethod,
      originalSaleHash: null,
      ...(lines ? { refundLines: lines } : {}),
    },
  }
}

describe('remboursements structurés', () => {
  it('construit plusieurs lignes depuis le snapshot historique et calcule leur TVA', () => {
    const lines = buildRefundLines(printPreviewOrder, [
      { originalLineId: 'burger-samhain::', quantity: 1 },
      { originalLineId: 'biere-classique::25cl', quantity: 2 },
    ])
    expect(lines).toEqual([
      expect.objectContaining({ grossCents: 1600, vatRate: 10, vatCents: 145 }),
      expect.objectContaining({ grossCents: 700, vatRate: 20, vatCents: 117 }),
    ])
    expect(refundLinesTotalCents(lines)).toBe(2300)
  })

  it.each([0, -1, 1.5])('refuse la quantité invalide %s', (quantity) => {
    expect(() =>
      buildRefundLines(printPreviewOrder, [{ originalLineId: 'burger-samhain::', quantity }]),
    ).toThrow(/quantité.*entier strictement positif/i)
  })

  it('calcule le restant après des remboursements successifs et refuse le dépassement', () => {
    const first = buildRefundLines(printPreviewOrder, [
      { originalLineId: 'burger-samhain::', quantity: 1 },
    ])
    const correction = refund(first, -1600)
    expect(deriveRefundAvailability(printPreviewOrder, [correction]).lines[0]).toMatchObject({
      soldQuantity: 2,
      refundedQuantity: 1,
      remainingQuantity: 1,
    })
    const requested = buildRefundLines(printPreviewOrder, [
      { originalLineId: 'burger-samhain::', quantity: 2 },
    ])
    expect(() => validateStructuredRefund(printPreviewOrder, [correction], requested)).toThrow(
      /quantité remboursable restante/i,
    )
  })

  it('conserve les anciennes corrections lisibles mais interdit de deviner leurs lignes', () => {
    const legacy = refund(undefined, -500)
    expect(deriveRefundAvailability(printPreviewOrder, [legacy]).hasLegacyAmountOnlyRefund).toBe(
      true,
    )
    const requested = buildRefundLines(printPreviewOrder, [
      { originalLineId: 'crepe-chocolat::', quantity: 1 },
    ])
    expect(() => validateStructuredRefund(printPreviewOrder, [legacy], requested)).toThrow(
      /ancien remboursement sans détail/i,
    )
  })
})
