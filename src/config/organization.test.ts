import { describe, expect, it } from 'vitest'
import {
  assertReceiptBusinessInfoReadyForProduction,
  receiptBusinessInfo,
  type ReceiptBusinessInfo,
} from './organization'

describe('configuration administrative de production', () => {
  it('accepte les informations administratives réelles configurées', () => {
    expect(() => assertReceiptBusinessInfoReadyForProduction()).not.toThrow()
  })

  it('refuse un marqueur de démonstration actif', () => {
    expect(() =>
      assertReceiptBusinessInfoReadyForProduction({
        ...receiptBusinessInfo,
        usesDemoPlaceholders: true,
      }),
    ).toThrow('usesDemoPlaceholders')
  })

  it('refuse un placeholder connu même si le marqueur de démonstration est désactivé', () => {
    expect(() =>
      assertReceiptBusinessInfoReadyForProduction({
        ...receiptBusinessInfo,
        siret: '000 000 000 00000',
        usesDemoPlaceholders: false,
      }),
    ).toThrow('siret')
  })

  it('refuse un placeholder textuel manifeste', () => {
    expect(() =>
      assertReceiptBusinessInfoReadyForProduction({
        ...receiptBusinessInfo,
        organizationName: 'Association de démonstration',
      }),
    ).toThrow('organizationName (valeur manifestement fictive)')
  })

  it('refuse les valeurs vides et les identifiants administratifs invalides', () => {
    const invalidBusinessInfo: ReceiptBusinessInfo = {
      ...receiptBusinessInfo,
      address: ' ',
      siret: '123',
      vatNumber: 'FR00 000000000',
    }

    expect(() => assertReceiptBusinessInfoReadyForProduction(invalidBusinessInfo)).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/address.*siret.*vatNumber/),
      }),
    )
  })
})
