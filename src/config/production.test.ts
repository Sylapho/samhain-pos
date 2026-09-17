import { describe, expect, it } from 'vitest'
import type { Product } from '../types/catalog'
import type { ReceiptBusinessInfo } from './organization'
import { assertProductionBuildReady } from './production'

const confirmedBusinessInfo: ReceiptBusinessInfo = {
  organizationName: 'Association Les Trouble-fêtes',
  eventName: 'Samhain',
  city: 'Bernay',
  address: '24 rue Alsace Lorraine 27300 Bernay',
  siret: '923 116 628 00028',
  vatNumber: 'FR90 923116628',
  usesDemoPlaceholders: false,
}

const temporaryCatalog: Product[] = [
  {
    id: 'produit-temporaire',
    name: 'Produit temporaire',
    categoryId: 'assiettes',
    requiresPreparation: true,
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
  it('autorise la configuration de production réellement embarquée', () => {
    expect(() => assertProductionBuildReady({ command: 'build', mode: 'production' })).not.toThrow()
  })

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
    ).toThrowError(
      /Build de production bloqué.*Configuration administrative de production invalide/s,
    )
  })

  it('regroupe les erreurs administratives et catalogue d’une build production', () => {
    expect(() =>
      assertProductionBuildReady(
        { command: 'build', mode: 'production' },
        {
          businessInfo: { ...confirmedBusinessInfo, usesDemoPlaceholders: true },
          catalog: temporaryCatalog,
        },
      ),
    ).toThrowError(
      /Build de production bloqué.*usesDemoPlaceholders.*Catalogue de production invalide.*Produit "Produit temporaire"/s,
    )
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
