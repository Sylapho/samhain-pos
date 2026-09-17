import { describe, expect, it } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import type { CorrectionLedgerEntry } from '../types/salesLedger'
import { deriveSaleCorrectionSummary } from './saleCorrectionSummary'

function correction(
  type: 'cancellation' | 'refund' | 'adjustment',
  amountDeltaCents: number,
): CorrectionLedgerEntry {
  return {
    schemaVersion: 1,
    id: `correction:${type}:${amountDeltaCents}`,
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
      operationId: 'operation',
      originalOrderId: printPreviewOrder.id,
      originalOrderNumber: printPreviewOrder.orderNumber,
      originalReceiptNumber: printPreviewOrder.receiptNumber,
      type,
      reason: 'Test',
      amountDeltaCents,
      paymentMethod: printPreviewOrder.paymentMethod,
      originalSaleHash: null,
    },
  }
}

describe('résumé dérivé des corrections', () => {
  it('dérive les états actif, partiellement remboursé et remboursé sans muter la vente', () => {
    const original = structuredClone(printPreviewOrder)
    expect(deriveSaleCorrectionSummary(original, [])).toMatchObject({
      status: 'active',
      remainingRefundableCents: original.totalCents,
      canCancel: true,
      canRefund: true,
    })
    expect(deriveSaleCorrectionSummary(original, [correction('refund', -500)])).toMatchObject({
      status: 'partially-refunded',
      refundedAmountCents: 500,
      remainingRefundableCents: original.totalCents - 500,
      canCancel: false,
    })
    expect(
      deriveSaleCorrectionSummary(original, [correction('refund', -original.totalCents)]),
    ).toMatchObject({ status: 'refunded', remainingRefundableCents: 0, canRefund: false })
    expect(original).toEqual(printPreviewOrder)
  })

  it('dérive une annulation et interdit toute nouvelle correction financière', () => {
    expect(
      deriveSaleCorrectionSummary(printPreviewOrder, [
        correction('cancellation', -printPreviewOrder.totalCents),
      ]),
    ).toMatchObject({
      status: 'cancelled',
      remainingRefundableCents: 0,
      canCancel: false,
      canRefund: false,
    })
  })
})
