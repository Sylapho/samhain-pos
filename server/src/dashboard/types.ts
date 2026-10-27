export type Line = { name: string; quantity: number; unitPriceCents: number; details: string[] }
export type SaleRow = {
  id: string
  number: string
  receipt: string
  terminalId: string
  tablet: string
  at: string
  receivedAt: string | null
  method: string
  cents: number
  legacy: boolean
  lines: Line[]
}
export type CorrectionRow = {
  id: string
  order: string
  receipt: string
  terminalId: string
  tablet: string
  at: string
  cents: number
  method: string
  type: string
  reason: string
}
export type Dataset = { sales: SaleRow[]; corrections: CorrectionRow[] }
export type Filters = {
  from: string
  to: string
  terminal: string
  payment: string
  search: string
}
export type Totals = { count: number; gross: number; corrections: number; net: number }
export type Report = {
  generatedAt: string
  totals: Totals & { average: number; correctionCount: number; legacyCount: number }
  tablets: { id: string; name: string; lastReceivedAt: string | null; totals: Totals }[]
  payments: { name: string; totals: Totals }[]
  days: { day: string; totals: Totals }[]
  products: { name: string; quantity: number; cents: number }[]
  sales: SaleRow[]
  corrections: CorrectionRow[]
  saleCount: number
  page: number
  pageCount: number
}
