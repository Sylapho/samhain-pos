import type { Db, Document, FindCursor } from 'mongodb'
import type { Chain, LedgerEvent, Sale, Scope } from '../persistence/model.ts'
import { dataset } from './report.ts'
import type { Dataset } from './types.ts'
const limit = 50_000
async function rows<T extends Document & { payloadCanonical: string }>(
  cursor: FindCursor<T>,
  budget: { bytes: number },
): Promise<T[]> {
  const result: T[] = []
  try {
    for await (const row of cursor) {
      budget.bytes += Buffer.byteLength(row.payloadCanonical)
      if (result.length >= limit || budget.bytes > 64 * 1024 * 1024) throw new Error('LIMIT')
      result.push(row)
    }
    return result
  } finally {
    await cursor.close()
  }
}
export function dashboardStore(db: Db, configuredScope: Scope) {
  const scope = {
    organizationId: configuredScope.organizationId,
    festivalId: configuredScope.festivalId,
  }
  let cache: { data: Dataset; generatedAt: string; expiresAt: number } | undefined
  let loading: Promise<NonNullable<typeof cache>> | undefined
  async function read() {
    // Index prefixes use organization/festival. Aggregate counts avoid parsing oversized ledgers.
    const counts = await db
      .collection('ledgerEvents')
      .aggregate<{ _id: string; count: number }>(
        [
          { $match: { ...scope, kind: { $in: ['sale', 'correction'] } } },
          { $group: { _id: '$kind', count: { $sum: 1 } } },
        ],
        { maxTimeMS: 10000, readConcern: { level: 'majority' } },
      )
      .toArray()
    if (counts.reduce((sum, c) => sum + c.count, 0) > limit) throw new Error('LIMIT')
    const budget = { bytes: 0 }
    const events = await rows(
      db
        .collection<LedgerEvent>('ledgerEvents')
        .find(
          { ...scope, kind: { $in: ['sale', 'correction'] } },
          {
            projection: {
              _id: 0,
              kind: 1,
              chainId: 1,
              sourceTerminalId: 1,
              eventId: 1,
              recordedAt: 1,
              serverReceivedAt: 1,
              payloadCanonical: 1,
            },
            readConcern: { level: 'majority' },
            maxTimeMS: 10000,
          },
        )
        .limit(limit + 1),
      budget,
    )
    const legacy = await rows(
      db
        .collection<Extract<Sale, { type: 'legacy' }>>('sales')
        .find(
          { ...scope, type: 'legacy' },
          {
            projection: { _id: 0, type: 1, chainId: 1, sourceTerminalId: 1, payloadCanonical: 1 },
            readConcern: { level: 'majority' },
            maxTimeMS: 10000,
          },
        )
        .limit(limit + 1),
      budget,
    )
    // Only non-sensitive synchronization metadata; installations/auth collections are never read.
    const receipts = await db
      .collection('syncReceipts')
      .aggregate<{ _id: string; at: Date; sequence: number | null }>(
        [
          { $match: scope },
          {
            $group: {
              _id: '$chainId',
              at: { $max: '$serverReceivedAt' },
              sequence: { $max: '$sequence' },
            },
          },
          { $limit: 1001 },
        ],
        { maxTimeMS: 10000, readConcern: { level: 'majority' } },
      )
      .toArray()
    const chains = await db
      .collection<Chain>('chains')
      .find(scope, {
        projection: { _id: 0, chainId: 1, 'head.sequence': 1 },
        maxTimeMS: 5000,
        readConcern: { level: 'majority' },
      })
      .limit(1001)
      .toArray()
    if (receipts.length > 1000 || chains.length > 1000) throw new Error('LIMIT')
    const data = dataset(events, legacy)
    const keys = new Set([...receipts.map((r) => r._id), ...chains.map((c) => c.chainId)])
    data.sync = [...keys].map((chainId) => ({
      chainId,
      lastReceivedAt: receipts.find((r) => r._id === chainId)?.at.toISOString() ?? null,
      head: chains.find((c) => c.chainId === chainId)?.head.sequence ?? null,
      receivedSequence: receipts.find((r) => r._id === chainId)?.sequence ?? null,
    }))
    const now = Date.now()
    cache = { data, generatedAt: new Date(now).toISOString(), expiresAt: now + 15000 }
    return cache
  }
  return async () => {
    if (cache && Date.now() < cache.expiresAt) return cache
    if (!loading)
      loading = read().finally(() => {
        loading = undefined
      })
    return loading
  }
}
