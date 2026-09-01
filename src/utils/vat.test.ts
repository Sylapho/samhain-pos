import { describe, expect, it } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { calculateVatSummary } from './vat'

describe('calcul de TVA TTC', () => {
  it('calcule les montants en centimes et les ventile par taux', () => {
    expect(calculateVatSummary(printPreviewOrder.items)).toEqual({
      grossCents: 4150,
      netCents: 3719,
      vatCents: 431,
      breakdown: [
        { rate: 10, grossCents: 3450, netCents: 3136, vatCents: 314 },
        { rate: 20, grossCents: 700, netCents: 583, vatCents: 117 },
      ],
    })
  })
})
