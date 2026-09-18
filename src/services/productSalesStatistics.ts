import type { Product } from '../types/catalog'
import type { Order } from '../types/order'
import type { CorrectionLedgerEntry } from '../types/salesLedger'

export type ProductSalesRow = {
  productId: string
  productName: string
  quantity: number
  revenueCents: number
  quantitySharePercent: number | null
  complete: boolean
}

export type ProductSalesStatistics = {
  rows: ProductSalesRow[]
  totalQuantity: number
  hasSales: boolean
  hasUnallocatedCorrections: boolean
}

export type ProductFilterOption = {
  id: string
  name: string
}

type MutableProductTotal = {
  productId: string
  productName: string
  quantity: number
  revenueCents: number
  complete: boolean
}

export function listProductsForSalesStatistics(
  products: readonly Product[],
  orders: readonly Order[],
): ProductFilterOption[] {
  const names = new Map<string, string>()

  for (const order of [...orders].sort((left, right) => left.paidAt.localeCompare(right.paidAt))) {
    for (const item of order.items) names.set(item.productId, item.name)
  }
  for (const product of products) names.set(product.id, product.name)

  return [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'fr-FR') || left.id.localeCompare(right.id),
    )
}

export function calculateProductSalesStatistics({
  orders,
  corrections,
  products,
  selectedProductIds,
  now,
}: {
  orders: readonly Order[]
  corrections: readonly CorrectionLedgerEntry[]
  products: readonly Product[]
  selectedProductIds: ReadonlySet<string>
  now: Date
}): ProductSalesStatistics {
  const { start, end } = getLocalDayBounds(now)

  const productNames = new Map(
    listProductsForSalesStatistics(products, orders).map(({ id, name }) => [id, name]),
  )
  const totals = new Map<string, MutableProductTotal>()
  for (const [productId, productName] of productNames) {
    totals.set(productId, {
      productId,
      productName,
      quantity: 0,
      revenueCents: 0,
      complete: true,
    })
  }

  const correctionsByOrder = new Map<string, CorrectionLedgerEntry[]>()
  for (const correction of corrections) {
    const orderCorrections = correctionsByOrder.get(correction.correction.originalOrderId) ?? []
    orderCorrections.push(correction)
    correctionsByOrder.set(correction.correction.originalOrderId, orderCorrections)
  }

  let hasSales = false
  let hasUnallocatedCorrections = false

  for (const order of orders) {
    const paidAt = new Date(order.paidAt).getTime()
    if (!Number.isFinite(paidAt) || paidAt < start || paidAt >= end) continue

    const orderCorrections = correctionsByOrder.get(order.id) ?? []
    if (orderCorrections.some((entry) => entry.correction.type === 'cancellation')) continue
    hasSales = true

    for (const item of order.items) {
      const total = totals.get(item.productId)
      if (!total) continue
      total.quantity += item.quantity
      total.revenueCents += item.unitPriceCents * item.quantity
    }

    for (const correction of orderCorrections) {
      if (correction.correction.type === 'refund' && correction.correction.refundLines) {
        for (const line of correction.correction.refundLines) {
          const total = totals.get(line.productId)
          if (!total) continue
          total.quantity -= line.quantity
          total.revenueCents -= line.grossCents
        }
        continue
      }

      if (correction.correction.type === 'refund' || correction.correction.type === 'adjustment') {
        hasUnallocatedCorrections = true
        for (const item of order.items) {
          const total = totals.get(item.productId)
          if (total) total.complete = false
        }
      }
    }
  }

  const totalQuantity = [...totals.values()].reduce(
    (sum, total) => sum + Math.max(0, total.quantity),
    0,
  )
  const rows = [...totals.values()]
    .filter((total) => selectedProductIds.has(total.productId))
    .map<ProductSalesRow>((total) => {
      const quantity = Math.max(0, total.quantity)
      const revenueCents = Math.max(0, total.revenueCents)
      return {
        productId: total.productId,
        productName: total.productName,
        quantity,
        revenueCents,
        quantitySharePercent:
          total.complete && !hasUnallocatedCorrections && totalQuantity > 0
            ? (quantity / totalQuantity) * 100
            : total.complete && !hasUnallocatedCorrections
              ? 0
              : null,
        complete: total.complete,
      }
    })
    .sort(
      (left, right) =>
        right.quantity - left.quantity ||
        left.productName.localeCompare(right.productName, 'fr-FR') ||
        left.productId.localeCompare(right.productId),
    )

  return { rows, totalQuantity, hasSales, hasUnallocatedCorrections }
}

export function getLocalDayBounds(now: Date): { start: number; end: number } {
  if (Number.isNaN(now.getTime())) throw new Error('La date des statistiques est invalide.')
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.getTime(), end: end.getTime() }
}
