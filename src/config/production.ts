import { initialCatalogProducts } from '../data/initialCatalog.ts'
import type { Product } from '../types/catalog.ts'
import { assertCatalogReadyForProduction } from './catalog.ts'
import {
  assertReceiptBusinessInfoReadyForProduction,
  receiptBusinessInfo,
  type ReceiptBusinessInfo,
} from './organization.ts'

export type BuildContext = {
  command: string
  mode: string
}

export type ProductionConfiguration = {
  businessInfo?: ReceiptBusinessInfo
  catalog?: readonly Product[]
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Configuration inconnue.'
}

export function assertProductionBuildReady(
  { command, mode }: BuildContext,
  {
    businessInfo = receiptBusinessInfo,
    catalog = initialCatalogProducts,
  }: ProductionConfiguration = {},
): void {
  if (command !== 'build' || mode !== 'production') return

  const validationErrors: string[] = []

  try {
    assertReceiptBusinessInfoReadyForProduction(businessInfo)
  } catch (error) {
    validationErrors.push(getErrorMessage(error))
  }

  try {
    assertCatalogReadyForProduction(catalog)
  } catch (error) {
    validationErrors.push(getErrorMessage(error))
  }

  if (validationErrors.length > 0) {
    throw new Error(`Build de production bloqué.\n${validationErrors.join('\n')}`)
  }
}
