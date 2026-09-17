import { describe, expect, it } from 'vitest'
import {
  appendCashDigits,
  deleteLastCashDigit,
  getCashQuickAmounts,
  MAX_CASH_RECEIVED_CENTS,
} from './cashPayment'

describe('saisie du paiement en espèces', () => {
  it('saisit naturellement les euros et les centimes avec les zéros rapides', () => {
    expect(appendCashDigits(2, 0, 100)).toBe(200)

    const twentyFifty = [2, 0, 5, 0].reduce<number | null>(
      (amount, digit) => appendCashDigits(amount, digit),
      null,
    )
    expect(twentyFifty).toBe(2_050)
  })

  it('supprime le dernier chiffre et remet une saisie à un chiffre à vide', () => {
    expect(deleteLastCashDigit(2_050)).toBe(205)
    expect(deleteLastCashDigit(5)).toBeNull()
    expect(deleteLastCashDigit(null)).toBeNull()
  })

  it('refuse une saisie manuelle supérieure à six chiffres', () => {
    expect(appendCashDigits(MAX_CASH_RECEIVED_CENTS, 9)).toBe(MAX_CASH_RECEIVED_CENTS)
    expect(appendCashDigits(10_000, 0, 100)).toBe(10_000)
  })

  it('propose uniquement des montants simples supérieurs au total', () => {
    expect(getCashQuickAmounts(1_750)).toEqual([2_000, 3_000, 5_000])
    expect(getCashQuickAmounts(5_000)).toEqual([6_000, 10_000, 20_000])
    expect(getCashQuickAmounts(9_900)).toEqual([10_000, 15_000, 20_000])
  })
})
