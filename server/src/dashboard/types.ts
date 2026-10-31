export type Selection = { id: string; name: string }
export type Line = {
  lineId: string
  productId: string
  name: string
  quantity: number
  unitPriceCents: number
  vatRate: number
  details: string[]
  variant: Selection | null
  options: (Selection & { groupId: string; supplement: boolean })[]
  removed: Selection[]
}
export type RefundLine = {
  originalLineId: string
  productId: string
  productName: string
  quantity: number
  unitPriceCents: number
  vatRate: number
  grossCents: number
  vatCents: number
}
export type CorrectionRow = {
  id: string
  chainId: string
  originalId: string
  order: string
  receipt: string
  terminalId: string
  tablet: string
  at: string
  day: string
  hour: number
  cents: number
  method: string
  type: string
  reason: string
  refundLines: RefundLine[] | null
}
export type SaleRow = {
  id: string
  chainId: string
  number: string
  receipt: string
  terminalId: string
  tablet: string
  at: string
  day: string
  hour: number
  receivedAt: string | null
  method: string
  cents: number
  legacy: boolean
  lines: Line[]
}
export type SyncEvidence = {
  chainId: string
  lastReceivedAt: string | null
  head: number | null
  receivedSequence: number | null
}
export type Dataset = { sales: SaleRow[]; corrections: CorrectionRow[]; sync?: SyncEvidence[] }
export type Filters = {
  from: string
  to: string
  terminal: string
  payment: string
  search: string
  productIds?: string
  productQuery?: string
  corrected?: string
  compareFrom?: string
  compareTo?: string
}
export type Totals = {
  count: number
  gross: number
  corrections: number
  net: number
  articles: number
  average: number
  articlesAverage: number
}
export type Bucket = { day: string; totals: Totals }
export type Hour = { hour: number; totals: Totals }
export type ProductRow = {
  id: string
  name: string
  names: string[]
  quantity: number
  netQuantity: number | null
  cents: number
  netCents: number | null
  orderCount: number
  quantityShare: number
  revenueShare: number
}
export type TaxRow = {
  rate: number
  gross: number
  excludingVat: number
  vat: number
  corrections: number | null
  correctionVat: number | null
  net: number | null
  netExcludingVat: number | null
  netVat: number | null
}
export type ChoiceRow = {
  id: string
  productId: string
  productName: string
  name: string
  kind: 'variant' | 'option' | 'removed'
  quantity: number
  supplement: boolean
}
export type Tablet = {
  id: string
  name: string
  totals: Totals
  payments: { name: string; totals: Totals }[]
  lastReceivedAt: string | null
  lastSyncAt: string | null
  pending: null
  warning: string | null
}
export type DashboardSettings = {
  days: { label: string; date: string }[]
  defaultPeriod: { from: string; to: string }
  refreshSeconds: number
  staleMinutes: number
  goals: { daily: number | null; festival: number | null }
  timeZone: string
}
export type PublicCorrection = Omit<CorrectionRow, 'chainId'>
export type Report = {
  generatedAt: string
  filters: Filters
  totals: Totals & { correctionCount: number; legacyCount: number }
  tablets: Tablet[]
  payments: { name: string; totals: Totals; share: number }[]
  days: Bucket[]
  hours: Hour[]
  festival: (Bucket & { cumulativeGross: number; cumulativeNet: number; cumulativeCount: number })[]
  comparison: {
    from: string
    to: string
    totals: Totals
    hours: Hour[]
    available: boolean
    differences: {
      key: 'gross' | 'count' | 'average' | 'articles'
      absolute: number
      percent: number | null
    }[]
  }
  products: ProductRow[]
  productOptions: Selection[]
  choices: ChoiceRow[]
  categories: { available: false; reason: string }
  tax: {
    rows: TaxRow[]
    total: Omit<TaxRow, 'rate'>
    complete: boolean
    unallocatedCorrections: number
  }
  sales: (Omit<SaleRow, 'chainId'> & { corrections: PublicCorrection[]; correctedCents: number })[]
  corrections: PublicCorrection[]
  saleCount: number
  page: number
  pageCount: number
  correctionCount: number
  correctionPage: number
  correctionPageCount: number
  goals: { label: string; target: number; actual: number; percent: number; remaining: number }[]
  warnings: string[]
}
export type ExportKind =
  'orders' | 'lines' | 'products' | 'categories' | 'tablets' | 'corrections' | 'days' | 'vat'
