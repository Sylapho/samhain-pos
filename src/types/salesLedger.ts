import type { Order, OrderPrinting, PaymentMethod } from './order'
import type { TerminalIdentity } from './terminal'

export const SALES_LEDGER_SCHEMA_VERSION = 1 as const
export const SALES_ARCHIVE_SCHEMA_VERSION = 1 as const

export type ImmutableOrderSnapshot = Omit<Order, 'printing' | 'integrity'>

export type LedgerSource = {
  softwareVersion: string
  buildMode: string
  terminal: TerminalIdentity
  organization: {
    organizationName: string
    eventName: string
    city: string
    address: string
    siret: string
    vatNumber: string
    phone: string
    usesDemoPlaceholders: boolean
  }
}

type LedgerEntryBase = {
  schemaVersion: typeof SALES_LEDGER_SCHEMA_VERSION
  id: string
  sequence: number
  recordedAt: string
  previousHash: string | null
  source: LedgerSource
  hash: string
}

export type SaleLedgerEntry = LedgerEntryBase & {
  kind: 'sale'
  orderId: string
  order: ImmutableOrderSnapshot
}

export type CorrectionType = 'cancellation' | 'refund' | 'adjustment'

export type SaleCorrection = {
  operationId: string
  originalOrderId: string
  originalOrderNumber: string
  originalReceiptNumber: string
  type: CorrectionType
  reason: string
  amountDeltaCents: number
  paymentMethod: PaymentMethod
  originalSaleHash: string | null
}

export type CorrectionLedgerEntry = LedgerEntryBase & {
  kind: 'correction'
  correction: SaleCorrection
}

export type ClosureTotals = {
  saleCount: number
  grossSalesCents: number
  correctionCount: number
  correctionTotalCents: number
  netTotalCents: number
  cumulativeNetTotalCents: number
  paymentTotalsCents: Record<PaymentMethod, number>
}

export type SalesClosure = {
  operationId: string
  periodStart: string
  periodEnd: string
  totals: ClosureTotals
}

export type ClosureLedgerEntry = LedgerEntryBase & {
  kind: 'closure'
  closure: SalesClosure
}

export type SalesLedgerEntry = SaleLedgerEntry | CorrectionLedgerEntry | ClosureLedgerEntry

export type CorrectionRequest = {
  operationId: string
  originalOrderId: string
  type: CorrectionType
  reason: string
  amountDeltaCents: number
  recordedAt: string
  source: LedgerSource
}

export type ClosureRequest = {
  operationId: string
  periodStart: string
  periodEnd: string
  recordedAt: string
  source: LedgerSource
}

export type LedgerMetadataSnapshot = {
  nextOrderSequence: number
  nextReceiptSequence: number
  nextJournalSequence: number
  lastJournalHash: string | null
  lastClosureEnd?: string
}

export type StoredOrderTechnicalState = {
  orderId: string
  printing: OrderPrinting
}

export type IntegrityVerification = {
  valid: boolean
  complete: boolean
  entryCount: number
  sealedOrderCount: number
  legacyOrderIds: string[]
  errors: string[]
  warnings: string[]
  headHash: string | null
}

export type SalesArchive = {
  schemaVersion: typeof SALES_ARCHIVE_SCHEMA_VERSION
  archiveId: string
  exportedAt: string
  notice: string
  source: LedgerSource
  metadata: LedgerMetadataSnapshot
  orders: Array<ImmutableOrderSnapshot & { integrity?: Order['integrity'] }>
  technicalStates: StoredOrderTechnicalState[]
  entries: SalesLedgerEntry[]
  archiveHash: string
}

export type ArchiveRestoreResult = {
  restoredOrders: number
  restoredEntries: number
}
