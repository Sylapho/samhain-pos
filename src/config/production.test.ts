import { describe, expect, it } from 'vitest'
import type { Product } from '../types/catalog'
import type { ReceiptBusinessInfo } from './organization'
import { assertProductionBuildReady } from './production'

const confirmedBusinessInfo: ReceiptBusinessInfo = {
  organizationName: 'Organisation configurée',
  eventName: 'Événement configuré',
  city: 'Ville configurée',
  address: 'Adresse configurée',
  siret: 'SIRET configuré',
  vatNumber: 'TVA configurée',
  usesDemoPlaceholders: false,
}

const temporaryCatalog: Product[] = [
  {
    id: 'produit-temporaire',
    name: 'Produit temporaire',
    categoryId: 'assiettes',
    availability: 'available',
    priceCents: 1_000,
    vatRate: 10,
    dataConfidence: 'temporary',
  },
]

const confirmedCatalog: Product[] = temporaryCatalog.map((product) => ({
  ...product,
  dataConfidence: 'confirmed',
}))

describe('garde-fou de build de production', () => {
  it('bloque une build production lorsque le catalogue est temporaire', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'build', mode: 'production' },
        { businessInfo: confirmedBusinessInfo, catalog: temporaryCatalog },
      ),
    ).toThrowError(/Build de production bloqué.*Produit "Produit temporaire"/s)
  })

  it('autorise android-test avec le même catalogue temporaire', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'build', mode: 'android-test' },
        { businessInfo: confirmedBusinessInfo, catalog: temporaryCatalog },
      ),
    ).not.toThrow()
  })

  it('autorise une build production lorsque toute la configuration est confirmée', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'build', mode: 'production' },
        { businessInfo: confirmedBusinessInfo, catalog: confirmedCatalog },
      ),
    ).not.toThrow()
  })

  it('conserve le blocage administratif avec un catalogue confirmé', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'build', mode: 'production' },
        {
          businessInfo: { ...confirmedBusinessInfo, usesDemoPlaceholders: true },
          catalog: confirmedCatalog,
        },
      ),
    ).toThrowError(/Build de production bloqué.*Configuration de production invalide/s)
  })

  it('n’exécute pas le garde-fou pendant le serveur de développement', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'serve', mode: 'development' },
        { catalog: temporaryCatalog },
      ),
    ).not.toThrow()
  })
})
