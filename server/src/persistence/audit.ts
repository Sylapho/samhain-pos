import type { Db } from 'mongodb'
import type {
  CatalogHead,
  CatalogVersion,
  Chain,
  LedgerEvent,
  Sale,
  SyncReceipt,
  TerminalRange,
} from './model.ts'
import { PersistenceError } from './errors.ts'
import { ledgerDocument, legacyDocument, sha256 } from './proofs.ts'
import { stable, verifySchema } from './migrations.ts'
import { parseStrictJson } from '../json.ts'
import { object } from './proofs.ts'

// Offline operator check after a coherent restore. Read-only, never repairs evidence.
// No receipt is an ACK here; destination reconciliation remains mandatory in #134.
export async function auditEvidence(db: Db): Promise<void> {
  await verifySchema(db)
  const fail = (collection: string): never => {
    throw new PersistenceError('INVALID_DOCUMENT', collection)
  }
  const events = db.collection<LedgerEvent>('ledgerEvents')
  const sales = db.collection<Sale>('sales')
  const receipts = db.collection<SyncReceipt>('syncReceipts')
  let traversed = 0
  for await (const chain of db.collection<Chain>('chains').find()) {
    const scope = {
      organizationId: chain.organizationId,
      festivalId: chain.festivalId,
      chainId: chain.chainId,
    }
    if (
      !(await db.collection('organizations').findOne({ organizationId: chain.organizationId })) ||
      !(await db
        .collection('festivals')
        .findOne({ organizationId: chain.organizationId, festivalId: chain.festivalId }))
    )
      fail('chains')
    let head: { sequence: number; hash: string | null } = { sequence: 0, hash: null }
    let rangeEnd = 0
    for await (const range of db
      .collection<TerminalRange>('terminalRanges')
      .find(scope)
      .sort({ firstSequence: 1 })) {
      if (
        range.firstSequence <= rangeEnd ||
        (range.lastSequence !== null && range.lastSequence < range.firstSequence)
      )
        fail('terminalRanges')
      rangeEnd = range.lastSequence ?? Number.MAX_SAFE_INTEGER
    }
    for await (const event of events.find(scope).sort({ sequence: 1 })) {
      traversed++
      if (event.sequence !== head.sequence + 1 || event.previousHash !== head.hash)
        fail('ledgerEvents')
      const expected = ledgerDocument(scope, event, event.serverReceivedAt)
      for (const field of [
        'kind',
        'recordedAt',
        'orderId',
        'operationId',
        'sessionId',
        'referencedSessionId',
        'originalOrderId',
        'originalSaleHash',
      ] as const)
        if (expected[field] !== event[field]) fail('ledgerEvents')
      const receipt = await receipts.findOne({
        ...scope,
        eventType: 'ledger',
        eventId: event.eventId,
      })
      if (
        !receipt ||
        receipt.sequence !== event.sequence ||
        receipt.hash !== event.hash ||
        receipt.transportFingerprint !== event.transportFingerprint
      )
        fail('syncReceipts')
      if (event.originalOrderId) {
        const original = await sales.findOne({ ...scope, orderId: event.originalOrderId })
        if (
          !original ||
          (original.type === 'sealed' ? original.saleHash : null) !== event.originalSaleHash
        )
          fail('sales')
      }
      if (event.kind === 'sale') {
        const orderId = event.orderId ?? fail('sales')
        if (
          !(await sales.findOne({
            ...scope,
            orderId,
            type: 'sealed',
            ledgerEventId: event.eventId,
            saleHash: event.hash,
          }))
        )
          fail('sales')
      }
      if (
        event.referencedSessionId &&
        !(await events.findOne({
          ...scope,
          kind: 'cash_session_opened',
          sessionId: event.referencedSessionId,
          sequence: { $lt: event.sequence },
        }))
      )
        fail('ledgerEvents')
      if (
        !(await db.collection<TerminalRange>('terminalRanges').findOne({
          ...scope,
          sourceTerminalId: event.sourceTerminalId,
          firstSequence: { $lte: event.sequence },
          $or: [{ lastSequence: null }, { lastSequence: { $gte: event.sequence } }],
        }))
      )
        fail('terminalRanges')
      head = { sequence: event.sequence, hash: event.hash }
    }
    if (stable(head) !== stable(chain.head)) fail('chains')
  }
  if (traversed !== (await events.countDocuments())) fail('chains')
  for await (const sale of sales.find()) {
    const scope = {
      organizationId: sale.organizationId,
      festivalId: sale.festivalId,
      chainId: sale.chainId,
    }
    if (!(await db.collection<Chain>('chains').findOne(scope))) fail('chains')
    if (sale.type === 'sealed') {
      if (
        !(await events.findOne({
          ...scope,
          kind: 'sale',
          eventId: sale.ledgerEventId,
          orderId: sale.orderId,
          hash: sale.saleHash,
        }))
      )
        fail('sales')
    } else {
      legacyDocument(scope, {
        eventId: sale.orderId,
        sourceTerminalId: sale.sourceTerminalId,
        payloadCanonical: sale.payloadCanonical,
        transportFingerprint: sale.transportFingerprint,
      })
      const receipt = await receipts.findOne({
        ...scope,
        eventType: 'legacy_order',
        eventId: sale.orderId,
      })
      if (
        !receipt ||
        receipt.transportFingerprint !== sale.transportFingerprint ||
        receipt.hash !== null ||
        receipt.sequence !== null
      )
        fail('syncReceipts')
    }
  }
  for await (const receipt of receipts.find()) {
    const scope = {
      organizationId: receipt.organizationId,
      festivalId: receipt.festivalId,
      chainId: receipt.chainId,
    }
    if (receipt.eventType === 'ledger') {
      if (!(await events.findOne({ ...scope, eventId: receipt.eventId }))) fail('syncReceipts')
    } else if (!(await sales.findOne({ ...scope, orderId: receipt.eventId, type: 'legacy' })))
      fail('syncReceipts')
    if (
      !(await db.collection('installationKeys').findOne({
        installationId: receipt.installationId,
        enrollmentGeneration: receipt.enrollmentGeneration,
      }))
    )
      fail('installationKeys')
  }
  for await (const head of db.collection<CatalogHead>('catalogHeads').find()) {
    const scope = { organizationId: head.organizationId, festivalId: head.festivalId }
    let revision = 0
    let versionId: string | null = null
    let hash: string | null = null
    for await (const version of db
      .collection<CatalogVersion>('catalogVersions')
      .find(scope)
      .sort({ revision: 1 })) {
      if (version.revision !== ++revision || sha256(version.payload) !== version.sha256)
        fail('catalogVersions')
      const payload = object(parseStrictJson(version.payload))
      if (
        payload.id !== version.versionId ||
        payload.organizationId !== version.organizationId ||
        payload.festivalId !== version.festivalId ||
        payload.revision !== version.revision ||
        payload.schemaVersion !== 1 ||
        payload.publishedAt !== version.publishedAt.toISOString()
      )
        fail('catalogVersions')
      versionId = version.versionId
      hash = version.sha256
    }
    if (head.revision !== revision || head.versionId !== versionId || head.sha256 !== hash)
      fail('catalogHeads')
  }
  for await (const version of db.collection<CatalogVersion>('catalogVersions').find()) {
    if (
      !(await db.collection<CatalogHead>('catalogHeads').findOne({
        organizationId: version.organizationId,
        festivalId: version.festivalId,
        revision: { $gte: version.revision },
      }))
    )
      fail('catalogHeads')
  }
}
