import { describe, expect, it } from 'vitest'
import {
  assertReceiptBusinessInfoReadyForProduction,
  receiptBusinessInfo,
  type ReceiptBusinessInfo,
} from './organization'

describe('configuration administrative de production', () => {
  it('refuse les données de démonstration actuelles', () => {
    expect(() => assertReceiptBusinessInfoReadyForProduction()).toThrow(
      'Configuration de production invalide',
    )
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

  it('accepte une configuration explicitement déclarée comme réelle sans placeholder connu', () => {
    const configuredBusinessInfo: ReceiptBusinessInfo = {
      organizationName: 'Organisation configurée',
      eventName: 'Événement configuré',
      city: 'Ville configurée',
      address: 'Adresse configurée',
      siret: 'SIRET configuré',
      vatNumber: 'TVA configurée',
      usesDemoPlaceholders: false,
    }

    expect(() => assertReceiptBusinessInfoReadyForProduction(configuredBusinessInfo)).not.toThrow()
  })
})
