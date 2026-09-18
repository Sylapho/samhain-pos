import { describe, expect, it } from 'vitest'
import { createValidCartItem } from '../test/orderFixtures'
import type { Product } from '../types/catalog'
import type { Order } from '../types/order'
import type { CorrectionLedgerEntry, RefundLine } from '../types/salesLedger'
import { calculateProductSalesStatistics, getLocalDayBounds } from './productSalesStatistics'

const products = [
  product('burger', 'Burger'),
  product('fries', 'Frites'),
  product('hot-dog', 'Hot-dog'),
]
const now = new Date(2026, 8, 1, 12)

describe('statistiques de ventes par produit', () => {
  it('additionne les quantités de plusieurs lignes et commandes', () => {
    const result = calculate([
      order('one', localDate(2026, 8, 1, 10), [line('burger', 'Burger', 2, 1_000)]),
      order('two', localDate(2026, 8, 1, 11), [line('burger', 'Burger', 3, 900)]),
    ])

    expect(result.rows.find(({ productId }) => productId === 'burger')).toMatchObject({
      quantity: 5,
      revenueCents: 4_700,
      quantitySharePercent: 100,
    })
  })

  it('agrège plusieurs produits par identifiant et garde le prix historique', () => {
    const result = calculate([
      order('one', localDate(2026, 8, 1, 10), [
        line('burger', 'Ancien nom', 2, 1_000),
        line('fries', 'Frites', 1, 300),
      ]),
    ])

    expect(result.rows).toEqual([
      expect.objectContaining({
        productId: 'burger',
        productName: 'Burger',
        quantity: 2,
        revenueCents: 2_000,
      }),
      expect.objectContaining({ productId: 'fries', quantity: 1, revenueCents: 300 }),
      expect.objectContaining({ productId: 'hot-dog', quantity: 0, revenueCents: 0 }),
    ])
  })

  it('exclut entièrement une commande annulée', () => {
    const cancelledOrder = order('cancelled', localDate(2026, 8, 1, 10), [
      line('burger', 'Burger', 4, 1_000),
    ])
    const result = calculate([cancelledOrder], [correction(cancelledOrder, 'cancellation')])

    expect(result.hasSales).toBe(false)
    expect(result.rows.find(({ productId }) => productId === 'burger')?.quantity).toBe(0)
  })

  it('conserve à zéro un produit sélectionné sans vente', () => {
    const result = calculate(
      [order('one', localDate(2026, 8, 1, 10), [line('burger', 'Burger', 2, 1_000)])],
      [],
      new Set(['hot-dog']),
    )

    expect(result.rows).toEqual([
      expect.objectContaining({ productId: 'hot-dog', quantity: 0, revenueCents: 0 }),
    ])
  })

  it('compte une vente d’aujourd’hui et ignore hier et demain', () => {
    const result = calculate([
      order('yesterday', localDate(2026, 7, 31, 23, 59, 59, 999), [
        line('burger', 'Burger', 7, 1_000),
      ]),
      order('today', localDate(2026, 8, 1, 12), [line('burger', 'Burger', 2, 1_000)]),
      order('tomorrow', localDate(2026, 8, 2, 0), [line('burger', 'Burger', 5, 1_000)]),
    ])

    expect(result.rows.find(({ productId }) => productId === 'burger')?.quantity).toBe(2)
  })

  it('déduit les quantités et montants des remboursements structurés', () => {
    const soldOrder = order('refunded', localDate(2026, 8, 1, 10), [
      line('burger', 'Burger', 10, 1_000),
    ])
    const refundLine: RefundLine = {
      originalLineId: soldOrder.items[0]!.lineId,
      productId: 'burger',
      productName: 'Burger',
      quantity: 2,
      unitPriceCents: 1_000,
      vatRate: 10,
      grossCents: 2_000,
      vatCents: 182,
    }
    const result = calculate([soldOrder], [correction(soldOrder, 'refund', [refundLine])])

    expect(result.rows.find(({ productId }) => productId === 'burger')).toMatchObject({
      quantity: 8,
      revenueCents: 8_000,
    })
  })

  it('signale une ancienne correction sans détail au lieu d’inventer une ventilation', () => {
    const soldOrder = order('legacy-refund', localDate(2026, 8, 1, 10), [
      line('burger', 'Burger', 2, 1_000),
      line('fries', 'Frites', 1, 300),
    ])
    const result = calculate([soldOrder], [correction(soldOrder, 'refund')])

    expect(result.hasUnallocatedCorrections).toBe(true)
    expect(result.rows.find(({ productId }) => productId === 'burger')?.complete).toBe(false)
    expect(result.rows.find(({ productId }) => productId === 'fries')?.complete).toBe(false)
    expect(result.rows.find(({ productId }) => productId === 'hot-dog')?.complete).toBe(true)
  })

  it('retourne des lignes à zéro sans erreur quand aujourd’hui ne contient aucune vente', () => {
    const result = calculate([])

    expect(result.hasSales).toBe(false)
    expect(result.totalQuantity).toBe(0)
    expect(result.rows).toHaveLength(3)
    expect(result.rows.every(({ quantity }) => quantity === 0)).toBe(true)
  })

  it('calcule les bornes de la journée locale courante', () => {
    const bounds = getLocalDayBounds(now)

    expect(new Date(bounds.start).getHours()).toBe(0)
    expect(new Date(bounds.start).getDate()).toBe(1)
    expect(new Date(bounds.end).getHours()).toBe(0)
    expect(new Date(bounds.end).getDate()).toBe(2)
  })
})

function calculate(
  orders: Order[],
  corrections: CorrectionLedgerEntry[] = [],
  selectedProductIds = new Set(products.map(({ id }) => id)),
) {
  return calculateProductSalesStatistics({
    orders,
    corrections,
    products,
    selectedProductIds,
    now,
  })
}

function localDate(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
): string {
  return new Date(year, month, day, hours, minutes, seconds, milliseconds).toISOString()
}

function product(id: string, name: string): Product {
  return {
    id,
    name,
    categoryId: 'assiettes',
    active: true,
    displayOrder: 0,
    requiresPreparation: true,
    availability: 'available',
    priceCents: 9_999,
    vatRate: 10,
  }
}

function line(productId: string, name: string, quantity: number, unitPriceCents: number) {
  return createValidCartItem({
    lineId: `${productId}-${quantity}-${unitPriceCents}`,
    productId,
    name,
    quantity,
    unitPriceCents,
  })
}

function order(id: string, paidAt: string, items: Order['items']): Order {
  const totalCents = items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0)
  return {
    id,
    orderNumber: id,
    receiptNumber: `receipt-${id}`,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    paidAt,
    items,
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    totalCents,
    createdAt: paidAt,
    status: 'confirmed',
    printing: {
      status: 'printed',
      pickupTicket: 'not_requested',
      customerReceipt: 'printed',
      preparationTicket: 'printed',
      attempts: 1,
      updatedAt: paidAt,
    },
  }
}

function correction(
  originalOrder: Order,
  type: 'cancellation' | 'refund',
  refundLines?: RefundLine[],
): CorrectionLedgerEntry {
  return {
    schemaVersion: 1,
    id: `correction-${originalOrder.id}-${type}`,
    sequence: 1,
    recordedAt: '2026-09-05T10:00:00.000Z',
    previousHash: null,
    hash: 'hash',
    kind: 'correction',
    source: {} as CorrectionLedgerEntry['source'],
    correction: {
      operationId: `operation-${originalOrder.id}-${type}`,
      originalOrderId: originalOrder.id,
      originalOrderNumber: originalOrder.orderNumber,
      originalReceiptNumber: originalOrder.receiptNumber,
      type,
      reason: 'Test',
      amountDeltaCents: -1_000,
      paymentMethod: originalOrder.paymentMethod,
      originalSaleHash: null,
      ...(refundLines ? { refundLines } : {}),
    },
  }
}
