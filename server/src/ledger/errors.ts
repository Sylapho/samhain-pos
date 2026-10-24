import { ApiError } from '../errors.ts'
import { PersistenceError } from '../persistence/errors.ts'
import { validatedRequestId } from './protocol.ts'

export function syncError(code: string, status: number, body: unknown) {
  if (['PROOF_REQUIRED', 'CHALLENGE_INVALID'].includes(code)) {
    code = 'ACCESS_REVOKED'
    status = 403
  }
  if (code === 'INVALID_DOCUMENT') {
    code = 'INVALID_PAYLOAD'
    status = 422
  }
  if (code === 'COMMIT_UNCERTAIN') {
    code = 'TRANSACTION_RETRY'
    status = 503
  }
  if (code === 'INVALID_PAYLOAD') status = 422
  const recovery = [
    'HEAD_MOVED',
    'MISSING_PREDECESSOR',
    'DEPENDENCY_MISSING',
    'PROTOCOL_UNSUPPORTED',
    'LEDGER_SCHEMA_UNSUPPORTED',
    'BATCH_TOO_LARGE',
  ]
  const category =
    status >= 500 || status === 429 || status === 408
      ? 'temporary'
      : status === 401 || status === 403
        ? 'auth'
        : recovery.includes(code)
          ? 'recovery'
          : 'permanent'
  return {
    status,
    body: {
      protocolVersion: 1,
      requestId: validatedRequestId(body),
      error: { code, category, retryable: category === 'temporary' },
    },
  }
}
export function ledgerFailure(error: unknown) {
  if (error instanceof ApiError) return { status: error.status, code: error.code }
  if (error instanceof PersistenceError) {
    const status =
      error.code === 'SCOPE_DENIED'
        ? 403
        : error.code === 'CHALLENGE_INVALID'
          ? 403
          : [
                'HEAD_MOVED',
                'MISSING_PREDECESSOR',
                'DEPENDENCY_MISSING',
                'EVENT_CONTENT_CONFLICT',
                'SEQUENCE_FORK',
                'DUPLICATE_ORDER_OTHER_CHAIN',
              ].includes(error.code)
            ? 409
            : ['INVALID_DOCUMENT', 'BUSINESS_INCONSISTENCY'].includes(error.code)
              ? 422
              : 503
    return { status, code: error.code }
  }
  return { status: 503, code: 'SERVER_UNAVAILABLE' }
}
