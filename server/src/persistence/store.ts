import { randomUUID } from 'node:crypto'
import type { ClientSession, Db, MongoClient } from 'mongodb'
import type {
  CatalogVersion,
  ChainScope,
  Documents,
  Head,
  LedgerEvent,
  Scope,
  Subject,
  SyncReceipt,
  TerminalRange,
  Capability,
} from './model.ts'
import { PersistenceError } from './errors.ts'
import { transaction } from './transactions.ts'
import { ledgerDocument, legacyDocument, object, sha256 } from './proofs.ts'
import type { LedgerProof, LegacyProof } from './proofs.ts'
import { parseStrictJson } from '../json.ts'
import { verifySchema } from './migrations.ts'
import { verifyRuntimePrivileges } from './roles.ts'

// Mandatory activation boundary for future HTTP handlers. The low-level factory
// below remains usable by isolated migrations/tests, which use different accounts.
export async function openPersistence(client: MongoClient, db: Db) {
  await verifySchema(db)
  await verifyRuntimePrivileges(db)
  return createPersistence(client, db)
}

export type TabletContext = ChainScope &
  Subject & {
    installationId: string
    enrollmentGeneration: number
    sessionId: string
    keyFingerprint: string
    nonceHash: string
    requestId: string
  }
export type BusinessValidation = (
  event: LedgerEvent,
  context: { db: Db; session: ClientSession },
) => Promise<void>

export function createPersistence(client: MongoClient, db: Db) {
  const c = <N extends keyof Documents>(name: N) => db.collection<Documents[N]>(name)
  const S = (scope: Scope): Scope => ({
    organizationId: scope.organizationId,
    festivalId: scope.festivalId,
  })
  const C = (scope: ChainScope): ChainScope => ({ ...S(scope), chainId: scope.chainId })
  async function touchScopes(scope: Scope, session: ClientSession) {
    for (const [collection, filter] of [
      ['organizations', { organizationId: scope.organizationId, active: true }],
      ['festivals', { ...S(scope), active: true }],
    ] as const) {
      const result = await db
        .collection(collection)
        .updateOne(filter, { $inc: { fence: 1 } }, { session })
      if (result.matchedCount !== 1) throw new PersistenceError('SCOPE_DENIED')
    }
  }
  async function touchGrant(
    scope: Scope,
    actor: Subject,
    capability: Capability,
    session: ClientSession,
  ) {
    await touchScopes(scope, session)
    if (
      (
        await c('scopeGrants').updateOne(
          { ...S(scope), issuer: actor.issuer, subject: actor.subject, capability, active: true },
          { $inc: { fence: 1 } },
          { session },
        )
      ).matchedCount !== 1
    )
      throw new PersistenceError('SCOPE_DENIED')
  }
  async function authorizeTablet(
    context: TabletContext,
    action: 'ledger-ingest-v1' | 'legacy-import-v1',
    session: ClientSession,
  ) {
    const scope = C(context)
    await touchScopes(scope, session)
    const identity = {
      ...scope,
      installationId: context.installationId,
      enrollmentGeneration: context.enrollmentGeneration,
      issuer: context.issuer,
      subject: context.subject,
    }
    if (
      (
        await c('installations').updateOne(
          { ...identity, active: true, authorization: 'authorized' },
          { $inc: { fence: 1 } },
          { session },
        )
      ).matchedCount !== 1
    )
      throw new PersistenceError('SCOPE_DENIED')
    if (
      (
        await c('apiSessions').updateOne(
          {
            ...identity,
            sessionId: context.sessionId,
            active: true,
            $expr: {
              $and: [{ $gt: ['$expiresAt', '$$NOW'] }, { $gt: ['$absoluteExpiresAt', '$$NOW'] }],
            },
          },
          { $inc: { fence: 1 } },
          { session },
        )
      ).matchedCount !== 1
    )
      throw new PersistenceError('SCOPE_DENIED')
    if (
      !(await c('installationKeys').findOne(
        {
          installationId: context.installationId,
          enrollmentGeneration: context.enrollmentGeneration,
          keyFingerprint: context.keyFingerprint,
        },
        { session },
      ))
    )
      throw new PersistenceError('SCOPE_DENIED')
    const chain = await c('chains').findOneAndUpdate(
      { ...scope, enrollmentGeneration: context.enrollmentGeneration },
      { $inc: { fence: 1 } },
      { session, returnDocument: 'after' },
    )
    if (!chain) throw new PersistenceError('SCOPE_DENIED')
    const challenge = await c('authChallenges').updateOne(
      {
        ...identity,
        sessionId: context.sessionId,
        nonceHash: context.nonceHash,
        keyFingerprint: context.keyFingerprint,
        purpose: 'session',
        action,
        consumedAt: null,
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      },
      { $currentDate: { consumedAt: true } },
      { session },
    )
    if (challenge.matchedCount !== 1) throw new PersistenceError('CHALLENGE_INVALID')
    return chain
  }
  async function receipt(
    context: TabletContext,
    event: { eventId: string; transportFingerprint: string; sequence?: number; hash?: string },
    eventType: SyncReceipt['eventType'],
    session: ClientSession,
  ): Promise<SyncReceipt> {
    const value: SyncReceipt = {
      ...C(context),
      documentSchemaVersion: 1,
      eventType,
      eventId: event.eventId,
      receiptId: randomUUID(),
      serverReceivedAt: new Date(),
      sequence: event.sequence ?? null,
      hash: event.hash ?? null,
      transportFingerprint: event.transportFingerprint,
      installationId: context.installationId,
      enrollmentGeneration: context.enrollmentGeneration,
      issuer: context.issuer,
      subject: context.subject,
      firstRequestId: context.requestId,
    }
    await c('syncReceipts').insertOne(value, { session })
    return value
  }
  async function existingReceipt(
    scope: ChainScope,
    eventId: string,
    eventType: SyncReceipt['eventType'],
    fingerprint: string,
    sequence: number | null,
    hash: string | null,
    session: ClientSession,
  ) {
    const value = await c('syncReceipts').findOne({ ...C(scope), eventId, eventType }, { session })
    if (
      !value ||
      value.transportFingerprint !== fingerprint ||
      value.sequence !== sequence ||
      value.hash !== hash
    )
      throw new PersistenceError('EVENT_CONTENT_CONFLICT')
    return value
  }
  async function checkReferences(event: LedgerEvent, session: ClientSession) {
    const scope = C(event)
    if (event.originalOrderId) {
      const sale = await c('sales').findOne(
        { ...scope, orderId: event.originalOrderId },
        { session },
      )
      if (!sale || (sale.type === 'sealed' ? sale.saleHash : null) !== event.originalSaleHash)
        throw new PersistenceError('DEPENDENCY_MISSING')
    }
    if (
      event.referencedSessionId &&
      !(await c('ledgerEvents').findOne(
        { ...scope, kind: 'cash_session_opened', sessionId: event.referencedSessionId },
        { session },
      ))
    )
      throw new PersistenceError('DEPENDENCY_MISSING')
    if (
      !(await c('terminalRanges').findOne(
        {
          ...scope,
          sourceTerminalId: event.sourceTerminalId,
          firstSequence: { $lte: event.sequence },
          $or: [{ lastSequence: null }, { lastSequence: { $gte: event.sequence } }],
        },
        { session },
      ))
    )
      throw new PersistenceError('SCOPE_DENIED')
  }
  return {
    // The caller is server-owned #132/#133 code: it must verify signatures and run
    // full business validation. No HTTP route is installed by this data foundation.
    async persistLedger(
      context: TabletContext,
      expectedHead: Head,
      proofs: readonly LedgerProof[],
      validateBusiness: BusinessValidation,
    ) {
      if (
        !proofs.length ||
        proofs.length > 100 ||
        new Set(proofs.map((p) => p.eventId)).size !== proofs.length ||
        typeof validateBusiness !== 'function'
      )
        throw new PersistenceError('INVALID_DOCUMENT')
      const events = proofs.map((proof) => ledgerDocument(C(context), proof, new Date()))
      if (events.some((event, i) => i > 0 && event.sequence !== events[i - 1]!.sequence + 1))
        throw new PersistenceError('MISSING_PREDECESSOR')
      return transaction(client, async (session) => {
        const chain = await authorizeTablet(context, 'ledger-ingest-v1', session)
        let head = chain.head
        let added = false
        const receipts: SyncReceipt[] = []
        for (const event of events) {
          const scope = C(context)
          const existing = await c('ledgerEvents').findOne(
            { ...scope, eventId: event.eventId },
            { session },
          )
          if (existing) {
            if (
              added ||
              existing.payloadCanonical !== event.payloadCanonical ||
              existing.hash !== event.hash ||
              existing.sequence !== event.sequence ||
              existing.previousHash !== event.previousHash ||
              existing.sourceTerminalId !== event.sourceTerminalId ||
              existing.ledgerCanonicalization !== event.ledgerCanonicalization ||
              existing.transportFingerprint !== event.transportFingerprint
            )
              throw new PersistenceError('EVENT_CONTENT_CONFLICT')
            receipts.push(
              await existingReceipt(
                scope,
                event.eventId,
                'ledger',
                event.transportFingerprint,
                event.sequence,
                event.hash,
                session,
              ),
            )
            continue
          }
          if (await c('ledgerEvents').findOne({ ...scope, sequence: event.sequence }, { session }))
            throw new PersistenceError('SEQUENCE_FORK')
          if (event.sequence > head.sequence + 1) throw new PersistenceError('MISSING_PREDECESSOR')
          if (event.sequence !== head.sequence + 1 || event.previousHash !== head.hash)
            throw new PersistenceError('SEQUENCE_FORK')
          if (
            !added &&
            (expectedHead.sequence !== head.sequence || expectedHead.hash !== head.hash)
          )
            throw new PersistenceError('HEAD_MOVED')
          if (
            event.operationId &&
            (await c('ledgerEvents').findOne(
              { ...scope, kind: event.kind, operationId: event.operationId },
              { session },
            ))
          )
            throw new PersistenceError('EVENT_CONTENT_CONFLICT')
          if (
            event.sessionId &&
            (await c('ledgerEvents').findOne(
              { ...scope, kind: 'cash_session_opened', sessionId: event.sessionId },
              { session },
            ))
          )
            throw new PersistenceError('EVENT_CONTENT_CONFLICT')
          await checkReferences(event, session)
          await validateBusiness(event, { db, session })
          if (event.kind === 'sale') {
            if (await c('sales').findOne({ ...S(context), orderId: event.orderId! }, { session }))
              throw new PersistenceError('DUPLICATE_ORDER_OTHER_CHAIN')
            await c('sales').insertOne(
              {
                ...scope,
                documentSchemaVersion: 1,
                type: 'sealed',
                orderId: event.orderId!,
                ledgerEventId: event.eventId,
                saleHash: event.hash,
              },
              { session },
            )
          }
          await c('ledgerEvents').insertOne(event, { session })
          receipts.push(await receipt(context, event, 'ledger', session))
          head = { sequence: event.sequence, hash: event.hash }
          added = true
        }
        if (
          added &&
          (
            await c('chains').updateOne(
              {
                ...C(context),
                enrollmentGeneration: context.enrollmentGeneration,
                fence: chain.fence,
                'head.sequence': chain.head.sequence,
                'head.hash': chain.head.hash,
              },
              { $set: { head }, $inc: { fence: 1 } },
              { session },
            )
          ).matchedCount !== 1
        )
          throw new PersistenceError('HEAD_MOVED')
        return { head, receipts }
      })
    },
    async persistLegacy(
      context: TabletContext,
      proof: LegacyProof,
      validateBusiness: (context: { db: Db; session: ClientSession }) => Promise<void>,
    ) {
      const sale = legacyDocument(C(context), proof)
      if (typeof validateBusiness !== 'function') throw new PersistenceError('INVALID_DOCUMENT')
      return transaction(client, async (session) => {
        await authorizeTablet(context, 'legacy-import-v1', session)
        const existing = await c('sales').findOne(
          { ...S(context), orderId: sale.orderId },
          { session },
        )
        if (existing) {
          if (existing.chainId !== context.chainId || existing.type !== 'legacy')
            throw new PersistenceError('DUPLICATE_ORDER_OTHER_CHAIN')
          if (
            existing.payloadCanonical !== sale.payloadCanonical ||
            existing.transportFingerprint !== sale.transportFingerprint ||
            existing.sourceTerminalId !== sale.sourceTerminalId
          )
            throw new PersistenceError('EVENT_CONTENT_CONFLICT')
          return existingReceipt(
            context,
            proof.eventId,
            'legacy_order',
            proof.transportFingerprint,
            null,
            null,
            session,
          )
        }
        if (
          !(await c('terminalRanges').findOne(
            { ...C(context), sourceTerminalId: proof.sourceTerminalId },
            { session },
          ))
        )
          throw new PersistenceError('SCOPE_DENIED')
        await validateBusiness({ db, session })
        await c('sales').insertOne(sale, { session })
        return receipt(context, proof, 'legacy_order', session)
      })
    },
    async publishCatalog(
      scope: Scope,
      actor: Subject,
      expectedRevision: number,
      version: CatalogVersion,
      validateContent: (payload: unknown) => void,
    ) {
      if (
        version.organizationId !== scope.organizationId ||
        version.festivalId !== scope.festivalId ||
        version.revision !== expectedRevision + 1 ||
        version.author.issuer !== actor.issuer ||
        version.author.subject !== actor.subject ||
        sha256(version.payload) !== version.sha256 ||
        Buffer.byteLength(version.payload) > 450000 ||
        typeof validateContent !== 'function'
      )
        throw new PersistenceError('INVALID_DOCUMENT')
      const payload = object(parseStrictJson(version.payload))
      if (
        payload.id !== version.versionId ||
        payload.revision !== version.revision ||
        payload.schemaVersion !== 1 ||
        payload.organizationId !== scope.organizationId ||
        payload.festivalId !== scope.festivalId ||
        payload.publishedAt !== version.publishedAt.toISOString() ||
        payload.origin !== `api:${actor.subject}`
      )
        throw new PersistenceError('INVALID_DOCUMENT')
      validateContent(payload)
      return transaction(client, async (session) => {
        await touchGrant(scope, actor, 'publish_catalog', session)
        const current = await c('catalogHeads').findOne(S(scope), { session })
        if ((current?.revision ?? 0) !== expectedRevision)
          throw new PersistenceError('CATALOG_CONFLICT')
        await c('catalogVersions').insertOne(version, { session })
        const update = {
          revision: version.revision,
          versionId: version.versionId,
          sha256: version.sha256,
        }
        if (!current)
          await c('catalogHeads').insertOne(
            { ...S(scope), documentSchemaVersion: 1, ...update },
            { session },
          )
        else if (
          (
            await c('catalogHeads').updateOne(
              { ...S(scope), revision: expectedRevision },
              { $set: update },
              { session },
            )
          ).matchedCount !== 1
        )
          throw new PersistenceError('CATALOG_CONFLICT')
        return { payload: version.payload, sha256: version.sha256 }
      })
    },
    async addTerminalRange(range: TerminalRange, session: ClientSession) {
      if (!session.inTransaction()) throw new PersistenceError('TRANSACTION_RETRY')
      if (
        !Number.isSafeInteger(range.firstSequence) ||
        range.firstSequence < 1 ||
        (range.lastSequence !== null &&
          (!Number.isSafeInteger(range.lastSequence) || range.lastSequence < range.firstSequence))
      )
        throw new PersistenceError('INVALID_DOCUMENT')
      if (
        (await c('chains').updateOne(C(range), { $inc: { fence: 1 } }, { session }))
          .matchedCount !== 1
      )
        throw new PersistenceError('SCOPE_DENIED')
      const overlapping = await c('terminalRanges').findOne(
        {
          ...C(range),
          firstSequence: { $lte: range.lastSequence ?? Number.MAX_SAFE_INTEGER },
          $or: [{ lastSequence: null }, { lastSequence: { $gte: range.firstSequence } }],
        },
        { session },
      )
      if (overlapping) throw new PersistenceError('TERMINAL_RANGE_CONFLICT')
      await c('terminalRanges').insertOne(range, { session })
    },
    async revokeInstallation(
      context: ChainScope & { installationId: string; enrollmentGeneration: number },
      actor: Subject,
    ) {
      return transaction(client, async (session) => {
        await touchGrant(context, actor, 'manage_enrollment', session)
        const filter = {
          ...C(context),
          installationId: context.installationId,
          enrollmentGeneration: context.enrollmentGeneration,
        }
        if (
          (
            await c('chains').updateOne(
              { ...C(context), enrollmentGeneration: context.enrollmentGeneration },
              { $inc: { fence: 1 } },
              { session },
            )
          ).matchedCount !== 1
        )
          throw new PersistenceError('SCOPE_DENIED')
        if (
          (
            await c('installations').updateOne(
              filter,
              { $set: { active: false, authorization: 'revoked' }, $inc: { fence: 1 } },
              { session },
            )
          ).matchedCount !== 1
        )
          throw new PersistenceError('SCOPE_DENIED')
        await c('apiSessions').updateMany(
          filter,
          { $set: { active: false }, $inc: { fence: 1 } },
          { session },
        )
      })
    },
  }
}
