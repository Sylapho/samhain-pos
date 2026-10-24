import type { ClientSession, MongoClient } from 'mongodb'
import { PersistenceError } from './errors.ts'
import { ApiError } from '../errors.ts'
import { setTimeout as delay } from 'node:timers/promises'

type TransactionSession = Pick<
  ClientSession,
  'startTransaction' | 'commitTransaction' | 'abortTransaction' | 'inTransaction' | 'endSession'
>
function label(error: unknown, name: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    error.hasErrorLabel(name) === true
  )
}
export function duplicate(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 11000
}

// Core API rather than withTransaction's long default retry window. Unknown commit
// outcomes retry only the same commit; callback results remain private until confirmed.
export async function runTransaction<T, S extends TransactionSession>(
  createSession: () => S,
  work: (session: S) => Promise<T>,
  options: { attempts?: number; commitAttempts?: number; budgetMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4
  const commits = options.commitAttempts ?? 3
  const deadline = performance.now() + (options.budgetMs ?? 15000)
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 10 ||
    !Number.isInteger(commits) ||
    commits < 1 ||
    commits > 10 ||
    !(options.budgetMs === undefined || (options.budgetMs > 0 && options.budgetMs <= 20000))
  )
    throw new PersistenceError('TRANSACTION_RETRY')
  for (let attempt = 0; attempt < attempts && performance.now() < deadline; attempt++) {
    const session = createSession()
    let uncertain = false
    try {
      session.startTransaction({
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true, wtimeoutMS: 2000 },
        maxCommitTimeMS: 2000,
      })
      const result = await work(session)
      for (let commit = 0; commit < commits && performance.now() < deadline; commit++) {
        try {
          await session.commitTransaction()
          return result
        } catch (error) {
          if (label(error, 'UnknownTransactionCommitResult')) {
            uncertain = true
            continue
          }
          // Once a commit is uncertain, no callback may be rerun in this request.
          if (uncertain) throw new PersistenceError('COMMIT_UNCERTAIN')
          throw error
        }
      }
      throw new PersistenceError(uncertain ? 'COMMIT_UNCERTAIN' : 'TRANSACTION_RETRY')
    } catch (error) {
      if (!uncertain && session.inTransaction())
        await session.abortTransaction().catch(() => undefined)
      if (uncertain) throw new PersistenceError('COMMIT_UNCERTAIN')
      // E11000 is not an ACK: rerun a fresh snapshot so the persistence operation
      // compares the winner's exact durable proof and classifies any conflict.
      if (label(error, 'TransientTransactionError') || duplicate(error)) {
        if (attempt + 1 < attempts && performance.now() + 5 * 2 ** attempt < deadline)
          await delay(5 * 2 ** attempt)
        continue
      }
      if (error instanceof PersistenceError || error instanceof ApiError) throw error
      throw new PersistenceError('TRANSACTION_RETRY')
    } finally {
      await session.endSession().catch(() => undefined)
    }
  }
  throw new PersistenceError('TRANSACTION_RETRY')
}

export function transaction<T>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return runTransaction(() => client.startSession(), work)
}
