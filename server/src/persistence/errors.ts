export type PersistenceCode =
  | 'SCHEMA_INCOMPATIBLE'
  | 'INDEX_INCOMPATIBLE'
  | 'INVALID_DOCUMENT'
  | 'TRANSACTIONS_REQUIRED'
  | 'TRANSACTION_RETRY'
  | 'COMMIT_UNCERTAIN'
  | 'SCOPE_DENIED'
  | 'CHALLENGE_INVALID'
  | 'HEAD_MOVED'
  | 'EVENT_CONTENT_CONFLICT'
  | 'SEQUENCE_FORK'
  | 'MISSING_PREDECESSOR'
  | 'DEPENDENCY_MISSING'
  | 'DUPLICATE_ORDER_OTHER_CHAIN'
  | 'CATALOG_CONFLICT'
  | 'TERMINAL_RANGE_CONFLICT'
  | 'BUSINESS_INCONSISTENCY'

export class PersistenceError extends Error {
  readonly code: PersistenceCode
  readonly collection: string | undefined
  readonly index: string | undefined
  constructor(code: PersistenceCode, collection?: string, index?: string) {
    // Never include driver exceptions, documents, IDs or credentials in diagnostics.
    super([code, collection, index].filter(Boolean).join(':'))
    this.code = code
    this.collection = collection
    this.index = index
  }
}
