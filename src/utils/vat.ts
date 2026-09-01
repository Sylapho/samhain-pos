import type { CartItem } from '../types/cart'
import type { VatRate } from '../types/catalog'

export type VatBreakdown = {
  rate: VatRate
  grossCents: number
  netCents: number
  vatCents: number
}

export type VatSummary = {
  grossCents: number
  netCents: number
  vatCents: number
  breakdown: VatBreakdown[]
}

export function calculateVatSummary(items: CartItem[]): VatSummary {
  const byRate = new Map<VatRate, VatBreakdown>()

  for (const item of items) {
    const grossCents = item.unitPriceCents * item.quantity
    const vatCents = Math.round((grossCents * item.vatRate) / (100 + item.vatRate))
    const current = byRate.get(item.vatRate) ?? {
      rate: item.vatRate,
      grossCents: 0,
      netCents: 0,
      vatCents: 0,
    }
    current.grossCents += grossCents
    current.vatCents += vatCents
    current.netCents += grossCents - vatCents
    byRate.set(item.vatRate, current)
  }

  const breakdown = [...byRate.values()].sort((left, right) => left.rate - right.rate)
  return {
    grossCents: breakdown.reduce((sum, entry) => sum + entry.grossCents, 0),
    netCents: breakdown.reduce((sum, entry) => sum + entry.netCents, 0),
    vatCents: breakdown.reduce((sum, entry) => sum + entry.vatCents, 0),
    breakdown,
  }
}
