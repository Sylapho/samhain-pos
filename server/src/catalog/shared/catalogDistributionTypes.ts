import type { Category, Product } from './catalog.ts'

export type CatalogContent = { products: Product[]; categories: Category[] }
export type CatalogPublication = CatalogContent & {
  id: string
  revision: number
  schemaVersion: 1
  publishedAt: string
  organizationId: string
  festivalId: string
  origin: string
}
// Hash covers the exact UTF-8 payload, including scope and publication metadata.
export type CatalogVersion = { payload: string; sha256: string }
export type CatalogConflict = {
  entity: 'products' | 'categories'
  id: string
  field: string
  base: unknown
  local: unknown
  remote: unknown
}
export type CatalogDecision = {
  versionId: string
  at: string
  choice: 'local' | 'remote'
  localRevision: number
  conflicts: CatalogConflict[]
}
export type CatalogDistributionState = {
  legacyMigrated: boolean
  base: CatalogContent
  active?: CatalogVersion
  pending?: CatalogVersion
  conflicts: CatalogConflict[]
  decisions: CatalogDecision[]
  error?: 'invalid_download' | 'sync_error'
}
export type CatalogSnapshot = CatalogContent & {
  revision: number
  distribution: CatalogDistributionState | null
}
export type CatalogCommit = CatalogSnapshot & { activation?: boolean }
