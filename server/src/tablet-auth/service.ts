import { randomUUID } from 'node:crypto'
import type { ClientSession, Db, MongoClient } from 'mongodb'
import type { AuthConfig } from './config.ts'
import type { AuthCrypto, SessionClaims } from './crypto.ts'
import { digest, publicKey, reject, sameHash, secret, verifyProof } from './crypto.ts'
import { chainOf, installationGuard, managerGuard, scopeOf, tabletGuard } from './guards.ts'
import { dossier, record } from './validation.ts'
import type {
  AuthEnrollment,
  AuthInstallation,
  AuthSession,
  Dossier,
  Proof,
  Rotation,
  SessionReply,
} from './types.ts'
import type {
  AdministrationAudit,
  AuthChallenge,
  Capability,
  Chain,
  ChainScope,
  InstallationKey,
  Scope,
  Subject,
  TerminalRange,
} from '../persistence/model.ts'
import { transaction } from '../persistence/transactions.ts'
import { stable } from '../persistence/migrations.ts'

export function createAuthService(
  client: MongoClient,
  db: Db,
  config: AuthConfig,
  crypto: AuthCrypto,
) {
  const requests = db.collection<AuthEnrollment>('enrollmentRequests')
  const installations = db.collection<AuthInstallation>('installations')
  const sessions = db.collection<AuthSession>('apiSessions')
  const challenges = db.collection<AuthChallenge>('authChallenges')
  const keys = db.collection<InstallationKey>('installationKeys')
  const audits = db.collection<AdministrationAudit>('administrationAudit')
  const buckets = new Map<string, { count: number; until: number }>()

  async function knownKey(
    installationId: string,
    candidate?: string,
    session?: ClientSession,
  ): Promise<string> {
    const options = session ? { session } : {}
    const installation = await installations.findOne({ installationId }, options)
    const key = installation
      ? await keys.findOne(
          { installationId, enrollmentGeneration: installation.enrollmentGeneration },
          options,
        )
      : null
    const pending = await requests.findOne({ installationId }, options)
    const spki = key?.publicKeySpki ?? pending?.publicKeySpki ?? candidate
    if (!spki || (candidate && candidate !== spki)) return reject('PROOF_REQUIRED', 403)
    publicKey(spki)
    return spki
  }
  async function consume(
    id: string,
    action: AuthChallenge['action'],
    proof: Proof,
    spki: string,
    session: ClientSession,
    sessionId?: string,
    requestId?: string,
  ) {
    verifyProof(id, action, proof.nonce, proof.raw, proof.signature, spki)
    const updated = await challenges.updateOne(
      {
        installationId: id,
        nonceHash: digest(proof.nonce),
        action,
        keyFingerprint: digest(spki),
        ...(sessionId ? { purpose: 'session', sessionId } : { purpose: 'enrollment' }),
        ...(requestId ? { requestId } : {}),
        consumedAt: null,
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      },
      { $currentDate: { consumedAt: true } },
      { session },
    )
    if (updated.matchedCount !== 1) reject('PROOF_REQUIRED', 403)
  }
  const publicStatus = (installation: AuthInstallation, chain: Chain) => ({
    status: installation.authorization,
    ...chainOf(installation),
    installationId: installation.installationId,
    enrollmentGeneration: installation.enrollmentGeneration,
    serverHead: chain.head,
  })
  async function issueSession(
    installation: AuthInstallation,
    keyFingerprint: string,
    session: ClientSession,
  ): Promise<SessionReply> {
    const now = Math.floor(Date.now() / 1000)
    const sessionId = randomUUID()
    const refresh = `${sessionId}.${secret()}`
    await sessions.insertOne(
      {
        documentSchemaVersion: 1,
        authVersion: 1,
        ...chainOf(installation),
        issuer: config.issuer,
        subject: installation.installationId,
        installationId: installation.installationId,
        enrollmentGeneration: installation.enrollmentGeneration,
        sessionId,
        refreshHash: digest(refresh),
        familyId: randomUUID(),
        active: true,
        expiresAt: new Date((now + config.idleDays * 86400) * 1000),
        absoluteExpiresAt: new Date((now + config.absoluteDays * 86400) * 1000),
        fence: 0,
        keyFingerprint,
      },
      { session },
    )
    const access = await crypto.sign(
      {
        sub: installation.installationId,
        sid: sessionId,
        jti: randomUUID(),
        ...chainOf(installation),
        enrollmentGeneration: installation.enrollmentGeneration,
      },
      now,
    )
    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: now + config.accessSeconds,
      expires_in: config.accessSeconds,
      token_type: 'bearer',
    }
  }
  async function audit(
    actor: Subject,
    scope: Scope,
    action: string,
    operationRequestId: string,
    fingerprint: string,
    targetId: string,
    outcome: string,
    session: ClientSession,
    at = new Date(),
  ) {
    const existing = await audits.findOne(
      {
        ...scopeOf(scope),
        issuer: actor.issuer,
        subject: actor.subject,
        action,
        idempotencyKey: operationRequestId,
      },
      { session },
    )
    if (existing) {
      if (existing.requestFingerprint !== fingerprint || existing.targetId !== targetId)
        reject('EVENT_CONTENT_CONFLICT', 409)
      return existing
    }
    const value: AdministrationAudit = {
      documentSchemaVersion: 1,
      ...scopeOf(scope),
      issuer: actor.issuer,
      subject: actor.subject,
      auditId: randomUUID(),
      action,
      idempotencyKey: operationRequestId,
      requestFingerprint: fingerprint,
      targetId,
      outcome,
      at,
    }
    await audits.insertOne(value, { session })
    return value
  }
  async function checkContinuity(
    request: AuthEnrollment,
    chain: Chain,
    session: ClientSession,
  ): Promise<boolean> {
    const local = dossier(JSON.parse(request.dossierCanonical))
    if (chain.head.sequence > local.prefix.length) return false
    let sequence = 0
    let headHash: string | null = null
    for await (const event of db
      .collection('ledgerEvents')
      .find(chainOf(chain), { session })
      .sort({ sequence: 1 })) {
      if (event.sequence !== sequence + 1 || event.previousHash !== headHash) return false
      const tuple = local.prefix[Number(event.sequence) - 1]
      if (
        !tuple ||
        tuple.eventId !== event.eventId ||
        tuple.hash !== event.hash ||
        tuple.terminalId !== event.sourceTerminalId
      )
        return false
      sequence++
      headHash = String(event.hash)
    }
    if (sequence !== chain.head.sequence || headHash !== chain.head.hash) return false
    for await (const sale of db
      .collection('sales')
      .find({ ...chainOf(chain), type: 'legacy' }, { session }))
      if (!local.legacyOrderIds.includes(String(sale.orderId))) return false
    const ranges = await db
      .collection<TerminalRange>('terminalRanges')
      .find(chainOf(chain), { session })
      .sort({ firstSequence: 1 })
      .toArray()
    for (const range of ranges) {
      if (range.lastSequence !== null && range.lastSequence > local.prefix.length) return false
      for (
        let sequence = range.firstSequence;
        sequence <= Math.min(range.lastSequence ?? local.prefix.length, local.prefix.length);
        sequence++
      )
        if (local.prefix[sequence - 1]?.terminalId !== range.sourceTerminalId) return false
    }
    return true
  }
  async function bindRanges(request: AuthEnrollment, chain: Chain, session: ClientSession) {
    const local = dossier(JSON.parse(request.dossierCanonical))
    const scope = chainOf(chain)
    const ranges = db.collection<TerminalRange>('terminalRanges')
    const previous = await ranges.findOne({ ...scope, lastSequence: null }, { session })
    let start = 1
    if (previous) {
      if (previous.firstSequence <= local.prefix.length) {
        await ranges.updateOne(
          { ...scope, firstSequence: previous.firstSequence, lastSequence: null },
          { $set: { lastSequence: local.prefix.length } },
          { session },
        )
        start = local.prefix.length + 1
      } else {
        // This open range has no accepted event: update only its future authorization.
        if (
          previous.firstSequence !== local.prefix.length + 1 ||
          chain.head.sequence >= previous.firstSequence
        )
          reject('RECOVERY_REQUIRED', 409)
        await ranges.updateOne(
          { ...scope, firstSequence: previous.firstSequence, lastSequence: null },
          { $set: { sourceTerminalId: local.terminalId, evidenceReference: request.requestId } },
          { session },
        )
        return
      }
    } else {
      const last = await ranges.find(scope, { session }).sort({ firstSequence: -1 }).next()
      start = (last?.lastSequence ?? 0) + 1
    }
    while (start <= local.prefix.length) {
      const terminal = local.prefix[start - 1]!.terminalId
      let end = start
      while (end < local.prefix.length && local.prefix[end]!.terminalId === terminal) end++
      await ranges.insertOne(
        {
          documentSchemaVersion: 1,
          ...scope,
          firstSequence: start,
          lastSequence: end,
          sourceTerminalId: terminal,
          evidenceReference: request.requestId,
        },
        { session },
      )
      start = end + 1
    }
    await ranges.insertOne(
      {
        documentSchemaVersion: 1,
        ...scope,
        firstSequence: start,
        lastSequence: null,
        sourceTerminalId: local.terminalId,
        evidenceReference: request.requestId,
      },
      { session },
    )
  }
  async function protectedTablet<T>(
    token: string,
    action: AuthChallenge['action'],
    proof: Proof,
    work: (state: Awaited<ReturnType<typeof tabletGuard>>, session: ClientSession) => Promise<T>,
    allowRecovery = false,
    signal?: AbortSignal,
  ) {
    const claims = await crypto.session(token)
    const key = await knownKey(claims.sub!)
    verifyProof(claims.sub!, action, proof.nonce, proof.raw, proof.signature, key)
    return transaction(
      client,
      async (session) => {
        const state = await tabletGuard(db, claims, session, allowRecovery)
        if (state.apiSession.keyFingerprint !== digest(key)) reject('PROOF_REQUIRED', 403)
        await consume(claims.sub!, action, proof, key, session, claims.sid)
        return work(state, session)
      },
      signal ? { signal } : {},
    )
  }
  return {
    crypto,
    config,
    protectedTablet,
    async protectedManager<T>(
      token: string,
      scope: Scope,
      capability: Capability,
      work: (actor: Subject, session: ClientSession) => Promise<T>,
    ) {
      const actor = await crypto.manager(token)
      return transaction(client, async (session) => {
        await managerGuard(db, scope, actor, capability, session)
        return work(actor, session)
      })
    },
    async challenge(body: {
      installationId: string
      action: AuthChallenge['action']
      publicKey?: string
      requestId?: string
    }) {
      const id = body.installationId
      const now = Date.now()
      for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key)
      let bucket = buckets.get(id)
      if (!bucket) {
        if (buckets.size >= 10000) reject('RATE_LIMITED', 429)
        bucket = { count: 0, until: now + 60000 }
        buckets.set(id, bucket)
      }
      if (++bucket.count > 60) reject('RATE_LIMITED', 429)
      const spki = await knownKey(id, body.publicKey)
      const nonce = secret()
      const expiresAt = new Date(now + 60000)
      if (
        body.action === 'request' ||
        body.action === 'activate' ||
        (body.action === 'status' && body.requestId)
      ) {
        if (
          body.action !== 'request' &&
          (!body.requestId ||
            !(await requests.findOne({ installationId: id, requestId: body.requestId })))
        )
          reject('PROOF_REQUIRED', 403)
        await challenges.insertOne({
          documentSchemaVersion: 1,
          purpose: 'enrollment',
          issuer: config.issuer,
          subject: `pending:${id}`,
          installationId: id,
          keyFingerprint: digest(spki),
          nonceHash: digest(nonce),
          expiresAt,
          consumedAt: null,
          ...(body.action === 'request'
            ? { action: 'request' }
            : { action: body.action, requestId: body.requestId! }),
        })
      } else {
        const installation = await installations.findOne({
          installationId: id,
          authVersion: 1,
          active: true,
        })
        if (!installation) reject('ACCESS_REVOKED', 403)
        // The refresh request identifies its session by a hashed credential below;
        // a challenge carries a public sessionId supplied only after possession is checked.
        const activeSessions = await sessions
          .find({
            installationId: id,
            active: true,
            authVersion: 1,
            enrollmentGeneration: installation!.enrollmentGeneration,
            $expr: {
              $and: [{ $gt: ['$expiresAt', '$$NOW'] }, { $gt: ['$absoluteExpiresAt', '$$NOW'] }],
            },
          })
          .limit(2)
          .toArray()
        if (activeSessions.length !== 1) reject()
        const current = activeSessions[0]!
        await challenges.insertOne({
          documentSchemaVersion: 1,
          purpose: 'session',
          ...chainOf(current),
          issuer: config.issuer,
          subject: id,
          sessionId: current.sessionId,
          installationId: id,
          enrollmentGeneration: current.enrollmentGeneration,
          keyFingerprint: digest(spki),
          nonceHash: digest(nonce),
          action: body.action as 'status',
          expiresAt,
          consumedAt: null,
        })
      }
      return { nonce, expiresAt: expiresAt.toISOString() }
    },
    async request(
      body: {
        installationId: string
        publicKey: string
        operationRequestId: string
        dossier: Dossier
        requestedScope?: Scope
      },
      proof: Proof,
    ) {
      publicKey(body.publicKey)
      verifyProof(
        body.installationId,
        'request',
        proof.nonce,
        proof.raw,
        proof.signature,
        body.publicKey,
      )
      return transaction(client, async (session) => {
        await installationGuard(db, body.installationId, session)
        await knownKey(body.installationId, body.publicKey, session)
        await consume(body.installationId, 'request', proof, body.publicKey, session)
        const existing = await requests.findOne(
          { installationId: body.installationId },
          { session },
        )
        const fingerprint = digest(proof.raw)
        if (existing?.operationRequestId === body.operationRequestId) {
          if (existing.requestFingerprint !== fingerprint) reject('EVENT_CONTENT_CONFLICT', 409)
          if (existing.expiresAt <= new Date()) reject('ENROLLMENT_EXPIRED', 410)
          return {
            requestId: existing.requestId,
            installationId: body.installationId,
            status: existing.status,
            expiresAt: existing.expiresAt.toISOString(),
          }
        }
        if (
          existing &&
          ['pending', 'approved'].includes(existing.status) &&
          existing.expiresAt > new Date() &&
          !(
            existing.status === 'approved' &&
            ((existing.invitationExpiresAt && existing.invitationExpiresAt <= new Date()) ||
              existing.attempts >= 5)
          )
        )
          reject('EVENT_CONTENT_CONFLICT', 409)
        const value: AuthEnrollment = {
          documentSchemaVersion: 1,
          authVersion: 1,
          requestId: randomUUID(),
          installationId: body.installationId,
          publicKeySpki: body.publicKey,
          dossierCanonical: stable(body.dossier),
          ...(body.requestedScope ? { requestedScope: body.requestedScope } : {}),
          operationRequestId: body.operationRequestId,
          requestFingerprint: fingerprint,
          status: 'pending',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          attempts: 0,
        }
        if (existing)
          await requests.replaceOne({ installationId: body.installationId }, value, { session })
        else await requests.insertOne(value, { session })
        return {
          requestId: value.requestId,
          installationId: value.installationId,
          status: 'pending',
          expiresAt: value.expiresAt.toISOString(),
        }
      })
    },
    async detail(token: string, scope: Scope, requestId: string) {
      const actor = await crypto.manager(token)
      return transaction(client, async (session) => {
        await managerGuard(db, scope, actor, 'manage_enrollment', session)
        const value = await requests.findOne({ requestId, authVersion: 1 }, { session })
        if (
          !value ||
          (value.requestedScope &&
            (value.requestedScope.organizationId !== scope.organizationId ||
              value.requestedScope.festivalId !== scope.festivalId)) ||
          (value.approvedScope &&
            (value.approvedScope.organizationId !== scope.organizationId ||
              value.approvedScope.festivalId !== scope.festivalId))
        )
          reject('NOT_FOUND', 404)
        return {
          requestId,
          installationId: value!.installationId,
          status: value!.status,
          ...(value!.requestedScope ? { requestedScope: value!.requestedScope } : {}),
          dossier: JSON.parse(value!.dossierCanonical) as unknown,
          publicKeyFingerprint: digest(value!.publicKeySpki),
          expiresAt: value!.expiresAt.toISOString(),
        }
      })
    },
    async list(token: string, scope: Scope, cursor?: string, limit = 50) {
      const actor = await crypto.manager(token)
      const purpose = stable({ ...scopeOf(scope), ...actor, action: 'enrollment-list' })
      const after = cursor ? record(crypto.open(cursor, purpose)) : null
      if (
        after &&
        (typeof after.requestId !== 'string' ||
          typeof after.createdAt !== 'string' ||
          Number(after.expiresAt) <= Date.now())
      )
        reject('INVALID_ENVELOPE', 400)
      return transaction(client, async (session) => {
        await managerGuard(db, scope, actor, 'manage_enrollment', session)
        const rows = await requests
          .find(
            {
              authVersion: 1,
              $and: [
                {
                  $or: [
                    {
                      'requestedScope.organizationId': scope.organizationId,
                      'requestedScope.festivalId': scope.festivalId,
                    },
                    {
                      requestedScope: { $exists: false },
                      'approvedScope.organizationId': scope.organizationId,
                      'approvedScope.festivalId': scope.festivalId,
                    },
                  ],
                },
              ],
              ...(after
                ? {
                    $or: [
                      { createdAt: { $gt: new Date(String(after.createdAt)) } },
                      {
                        createdAt: new Date(String(after.createdAt)),
                        requestId: { $gt: String(after.requestId) },
                      },
                    ],
                  }
                : {}),
            },
            { session },
          )
          .sort({ createdAt: 1, requestId: 1 })
          .limit(limit + 1)
          .toArray()
        const items = rows.slice(0, limit).map((row) => ({
          requestId: row.requestId,
          installationId: row.installationId,
          status: row.status,
          ...(row.requestedScope ? { requestedScope: row.requestedScope } : {}),
          expiresAt: row.expiresAt.toISOString(),
        }))
        const last = rows[limit - 1]
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? crypto.seal(
                  {
                    requestId: last.requestId,
                    createdAt: last.createdAt.toISOString(),
                    expiresAt: Date.now() + 600000,
                  },
                  purpose,
                )
              : null,
        }
      })
    },
    async decide(
      token: string,
      requestId: string,
      body: Scope & {
        chainId: string
        operationRequestId: string
        decision: 'approve' | 'reject'
        replacesInstallationId?: string
      },
      raw: Buffer,
    ) {
      const actor = await crypto.manager(token)
      const fingerprint = digest(raw)
      return transaction(client, async (session) => {
        await managerGuard(db, body, actor, 'manage_enrollment', session)
        const request = await requests.findOne({ requestId, authVersion: 1 }, { session })
        if (
          !request ||
          (request.requestedScope &&
            (request.requestedScope.organizationId !== body.organizationId ||
              request.requestedScope.festivalId !== body.festivalId)) ||
          (request.approvedScope &&
            (request.approvedScope.organizationId !== body.organizationId ||
              request.approvedScope.festivalId !== body.festivalId))
        )
          reject('NOT_FOUND', 404)
        await installationGuard(db, request!.installationId, session)
        if (request!.expiresAt <= new Date()) reject('ENROLLMENT_EXPIRED', 410)
        const previous = await audits.findOne(
          {
            ...scopeOf(body),
            ...actor,
            action: 'enrollment-decision',
            idempotencyKey: body.operationRequestId,
          },
          { session },
        )
        if (previous) {
          if (previous.requestFingerprint !== fingerprint || previous.targetId !== requestId)
            reject('EVENT_CONTENT_CONFLICT', 409)
          if (request!.decisionOperationId !== body.operationRequestId)
            reject('RECOVERY_REQUIRED', 409)
          if (request!.status === 'rejected') return { requestId, status: 'rejected' }
          // Invitations are hash-only. A lost approval response needs a new explicit decision.
          reject('INVITATION_UNAVAILABLE', 409)
        }
        if (request!.status === 'activated' || request!.status === 'rejected')
          reject('EVENT_CONTENT_CONFLICT', 409)
        const local = dossier(JSON.parse(request!.dossierCanonical))
        if (local.chainId !== body.chainId) reject('SCOPE_DENIED', 403)
        let chain: Chain | null = await db
          .collection<Chain>('chains')
          .findOne({ chainId: body.chainId }, { session })
        if (
          chain &&
          (chain.organizationId !== body.organizationId || chain.festivalId !== body.festivalId)
        )
          reject('SCOPE_DENIED', 403)
        if (body.decision === 'approve' && local.restored && !chain)
          reject('RECOVERY_REQUIRED', 409)
        if (!chain && body.decision === 'approve') {
          chain = {
            documentSchemaVersion: 1,
            ...scopeOf(body),
            chainId: body.chainId,
            enrollmentGeneration: 1,
            head: { sequence: 0, hash: null },
            fence: 0,
          }
          await db.collection<Chain>('chains').insertOne(chain, { session })
        }
        const active = await installations.findOne({ ...chainOf(body), active: true }, { session })
        if (
          body.decision === 'approve' &&
          ((active &&
            active.installationId !== request!.installationId &&
            active.installationId !== body.replacesInstallationId) ||
            (body.replacesInstallationId &&
              (!active || active.installationId !== body.replacesInstallationId)))
        )
          reject('REPLACEMENT_CONFLICT', 409)
        const invitation = secret()
        const expiresAt = new Date(Date.now() + 600000)
        const response =
          body.decision === 'approve'
            ? {
                requestId,
                status: 'approved',
                invitationCode: invitation,
                expiresAt: expiresAt.toISOString(),
              }
            : { requestId, status: 'rejected' }
        await requests.updateOne(
          { requestId },
          {
            $set: {
              status: body.decision === 'approve' ? 'approved' : 'rejected',
              approvedScope: {
                ...chainOf(body),
                ...(body.replacesInstallationId
                  ? { replacesInstallationId: body.replacesInstallationId }
                  : {}),
              },
              approvedBy: actor,
              approvedAt: new Date(),
              decisionOperationId: body.operationRequestId,
              decisionFingerprint: fingerprint,
              ...(body.decision === 'approve'
                ? {
                    expectedGeneration: chain!.enrollmentGeneration,
                    expectedInstallationId: active?.installationId ?? null,
                    invitationHash: digest(invitation),
                    invitationExpiresAt: expiresAt,
                    attempts: 0,
                  }
                : {}),
            },
          },
          { session },
        )
        await audit(
          actor,
          body,
          'enrollment-decision',
          body.operationRequestId,
          fingerprint,
          requestId,
          body.decision,
          session,
        )
        return response
      })
    },
    async activate(
      requestId: string,
      body: { installationId: string; invitationCode: string; operationRequestId: string },
      proof: Proof,
    ) {
      const spki = await knownKey(body.installationId)
      verifyProof(body.installationId, 'activate', proof.nonce, proof.raw, proof.signature, spki)
      const result = await transaction(client, async (session) => {
        const request = await requests.findOne(
          { requestId, installationId: body.installationId, authVersion: 1 },
          { session },
        )
        if (!request?.approvedScope) reject('PROOF_REQUIRED', 403)
        if (!request.approvedBy) reject('PROOF_REQUIRED', 403)
        await managerGuard(
          db,
          request.approvedScope!,
          request.approvedBy,
          'manage_enrollment',
          session,
        )
        await installationGuard(db, body.installationId, session)
        const fresh = await requests.findOne({ requestId }, { session })
        if (!fresh || fresh.publicKeySpki !== spki) reject('PROOF_REQUIRED', 403)
        await consume(body.installationId, 'activate', proof, spki, session, undefined, requestId)
        if (fresh!.status === 'activated') {
          if (
            fresh!.activationOperationId !== body.operationRequestId ||
            fresh!.activationFingerprint !== digest(proof.raw)
          )
            reject('EVENT_CONTENT_CONFLICT', 409)
          const active = await installations.findOne(
            { installationId: body.installationId, active: true, authVersion: 1 },
            { session },
          )
          if (
            !active ||
            !fresh!.responseExpiresAt ||
            fresh!.responseExpiresAt <= new Date() ||
            !fresh!.activationResponseCiphertext
          )
            reject('RECOVERY_REQUIRED', 409)
          const recovered = record(
            crypto.open(fresh!.activationResponseCiphertext, `activation:${requestId}`),
          )
          const recoveredSession = record(recovered.session)
          const claims = await crypto.session(String(recoveredSession.access_token))
          const state = await tabletGuard(db, claims, session, true)
          if (state.apiSession.refreshHash !== digest(String(recoveredSession.refresh_token)))
            reject('RECOVERY_REQUIRED', 409)
          return recovered
        }
        if (
          fresh!.status !== 'approved' ||
          fresh!.expiresAt <= new Date() ||
          !fresh!.invitationExpiresAt ||
          fresh!.invitationExpiresAt <= new Date()
        )
          reject('ENROLLMENT_EXPIRED', 410)
        if (fresh!.attempts >= 5) return { failure: 'ATTEMPTS_EXCEEDED' }
        if (!fresh!.invitationHash || !sameHash(body.invitationCode, fresh!.invitationHash)) {
          await requests.updateOne({ requestId }, { $inc: { attempts: 1 } }, { session })
          return { failure: fresh!.attempts + 1 >= 5 ? 'ATTEMPTS_EXCEEDED' : 'INVITATION_INVALID' }
        }
        const scope = chainOf(fresh!.approvedScope!)
        if (!fresh.expectedGeneration) reject('RECOVERY_REQUIRED', 409)
        const chain = await db
          .collection<Chain>('chains')
          .findOneAndUpdate(
            { ...scope, enrollmentGeneration: fresh!.expectedGeneration },
            { $inc: { fence: 1 } },
            { session, returnDocument: 'after' },
          )
        if (!chain) reject('REPLACEMENT_CONFLICT', 409)
        const active = await installations.findOne({ ...scope, active: true }, { session })
        if ((active?.installationId ?? null) !== fresh!.expectedInstallationId)
          reject('REPLACEMENT_CONFLICT', 409)
        const previous = await installations.findOne(
          { installationId: body.installationId },
          { session },
        )
        if (
          previous &&
          (previous.chainId !== scope.chainId ||
            previous.organizationId !== scope.organizationId ||
            previous.festivalId !== scope.festivalId)
        )
          reject('SCOPE_DENIED', 403)
        const ready = await checkContinuity(fresh!, chain!, session)
        if (active) {
          await installations.updateOne(
            { installationId: active.installationId },
            {
              $set: { active: false, authorization: 'revoked', revokedAt: new Date() },
              $inc: { fence: 1 },
            },
            { session },
          )
          await sessions.updateMany(
            { installationId: active.installationId },
            { $set: { active: false }, $inc: { fence: 1 } },
            { session },
          )
        }
        const generation =
          chain!.enrollmentGeneration +
          (active ||
          previous ||
          (await keys.findOne({ installationId: body.installationId }, { session }))
            ? 1
            : 0)
        if (!Number.isSafeInteger(generation)) reject('RECOVERY_REQUIRED', 409)
        if (
          (
            await db.collection('chains').updateOne(
              {
                ...scope,
                enrollmentGeneration: chain!.enrollmentGeneration,
                fence: chain!.fence,
              },
              { $set: { enrollmentGeneration: generation }, $inc: { fence: 1 } },
              { session },
            )
          ).matchedCount !== 1
        )
          reject('REPLACEMENT_CONFLICT', 409)
        const installation: AuthInstallation = {
          documentSchemaVersion: 1,
          authVersion: 1,
          ...scope,
          installationId: body.installationId,
          issuer: config.issuer,
          subject: body.installationId,
          enrollmentGeneration: generation,
          active: true,
          authorization: ready ? 'authorized' : 'needs_recovery',
          fence: 0,
        }
        if (previous)
          await installations.replaceOne({ installationId: body.installationId }, installation, {
            session,
          })
        else await installations.insertOne(installation, { session })
        await keys.insertOne(
          {
            documentSchemaVersion: 1,
            installationId: body.installationId,
            enrollmentGeneration: generation,
            publicKeySpki: spki,
            keyFingerprint: digest(spki),
            createdAt: new Date(),
          },
          { session },
        )
        if (ready) await bindRanges(fresh!, chain!, session)
        const response = {
          ...publicStatus(installation, { ...chain!, enrollmentGeneration: generation }),
          session: await issueSession(installation, digest(spki), session),
        }
        await requests.updateOne(
          { requestId },
          {
            $set: {
              status: 'activated',
              activationOperationId: body.operationRequestId,
              activationFingerprint: digest(proof.raw),
              activationResponseCiphertext: crypto.seal(response, `activation:${requestId}`),
              responseExpiresAt: new Date(Date.now() + 60000),
            },
          },
          { session },
        )
        await audit(
          { issuer: config.issuer, subject: body.installationId },
          scope,
          'enrollment-activate',
          body.operationRequestId,
          digest(proof.raw),
          body.installationId,
          installation.authorization,
          session,
        )
        return response
      })
      if (result && typeof result === 'object' && 'failure' in result)
        reject(String(result.failure), 403)
      return result
    },
    async status(token: string, installationId: string, proof: Proof) {
      const claims = await crypto.session(token)
      if (claims.sub !== installationId) reject('SCOPE_DENIED', 403)
      return protectedTablet(
        token,
        'status',
        proof,
        async (state) => publicStatus(state.installation, state.chain),
        true,
      )
    },
    async pendingStatus(requestId: string, installationId: string, proof: Proof) {
      const spki = await knownKey(installationId)
      verifyProof(installationId, 'status', proof.nonce, proof.raw, proof.signature, spki)
      return transaction(client, async (session) => {
        await installationGuard(db, installationId, session)
        const request = await requests.findOne(
          { requestId, installationId, authVersion: 1 },
          { session },
        )
        if (!request || request.publicKeySpki !== spki) reject('PROOF_REQUIRED', 403)
        if (request.expiresAt <= new Date()) reject('ENROLLMENT_EXPIRED', 410)
        await consume(installationId, 'status', proof, spki, session, undefined, requestId)
        return {
          requestId,
          installationId,
          ...(request.requestedScope ? request.requestedScope : {}),
          status:
            request.status === 'rejected'
              ? 'rejected'
              : request.status === 'activated'
                ? 'needs_recovery'
                : 'pending',
        }
      })
    },
    async refresh(
      body: { installationId: string; refresh_token: string; rotationId: string },
      proof: Proof,
    ) {
      const spki = await knownKey(body.installationId)
      verifyProof(body.installationId, 'refresh', proof.nonce, proof.raw, proof.signature, spki)
      const result = await transaction(client, async (session) => {
        await installationGuard(db, body.installationId, session)
        const previousHash = digest(body.refresh_token)
        const rotations = db.collection<Rotation>('refreshRotations')
        const old = await rotations.findOne(
          { previousRefreshHash: previousHash, authVersion: 1 },
          { session },
        )
        const sessionId = body.refresh_token.split('.')[0]
        if (!sessionId || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(body.refresh_token)) reject()
        const stored = await sessions.findOne(
          { sessionId, installationId: body.installationId, authVersion: 1 },
          { session },
        )
        if (old && old.sessionId !== sessionId) reject()
        if (!stored) reject()
        const claims: SessionClaims = {
          sub: stored!.installationId,
          sid: stored!.sessionId,
          iss: config.issuer,
          ...chainOf(stored!),
          enrollmentGeneration: stored!.enrollmentGeneration,
        }
        const current = await tabletGuard(db, claims, session, true)
        if (current.apiSession.keyFingerprint !== digest(spki)) reject('PROOF_REQUIRED', 403)
        await consume(body.installationId, 'refresh', proof, spki, session, stored!.sessionId)
        if (!old && stored!.refreshHash !== previousHash) {
          await sessions.updateMany(
            { familyId: stored!.familyId },
            { $set: { active: false }, $inc: { fence: 1 } },
            { session },
          )
          return { failure: 'REFRESH_REPLAY' }
        }
        if (old) {
          if (old.rotationId !== body.rotationId || old.proofHash !== digest(proof.raw)) {
            await sessions.updateMany(
              { familyId: stored!.familyId },
              { $set: { active: false }, $inc: { fence: 1 } },
              { session },
            )
            return { failure: 'REFRESH_REPLAY' }
          }
          if (old.expiresAt <= new Date()) return { failure: 'RECOVERY_REQUIRED' }
          return crypto.open(
            old.responseCiphertext,
            `rotation:${stored!.sessionId}:${body.rotationId}`,
          )
        }
        const now = Math.floor(Date.now() / 1000)
        const refresh = `${stored!.sessionId}.${secret()}`
        const response: SessionReply = {
          access_token: await crypto.sign({ ...claims, jti: randomUUID() }, now),
          refresh_token: refresh,
          expires_at: now + config.accessSeconds,
          expires_in: config.accessSeconds,
          token_type: 'bearer',
        }
        const expiresAt = new Date(
          Math.min(Date.now() + config.idleDays * 86400000, stored!.absoluteExpiresAt.getTime()),
        )
        if (
          (
            await sessions.updateOne(
              { sessionId: stored!.sessionId, refreshHash: previousHash, active: true },
              { $set: { refreshHash: digest(refresh), expiresAt }, $inc: { fence: 1 } },
              { session },
            )
          ).matchedCount !== 1
        )
          reject('REFRESH_REPLAY', 409)
        await rotations.insertOne(
          {
            documentSchemaVersion: 1,
            authVersion: 1,
            sessionId: stored!.sessionId,
            rotationId: body.rotationId,
            previousRefreshHash: previousHash,
            proofHash: digest(proof.raw),
            responseCiphertext: crypto.seal(
              response,
              `rotation:${stored!.sessionId}:${body.rotationId}`,
            ),
            expiresAt: new Date(Date.now() + 60000),
          },
          { session },
        )
        return response
      })
      if (result && typeof result === 'object' && 'failure' in result)
        reject(String(result.failure), 409)
      return result
    },
    async revoke(
      token: string,
      installationId: string,
      body: ChainScope & { operationRequestId: string },
      raw: Buffer,
    ) {
      const actor = await crypto.manager(token)
      return transaction(client, async (session) => {
        await managerGuard(db, body, actor, 'manage_enrollment', session)
        const existing = await audits.findOne(
          {
            ...scopeOf(body),
            ...actor,
            action: 'installation-revoke',
            idempotencyKey: body.operationRequestId,
          },
          { session },
        )
        if (
          existing &&
          (existing.targetId !== installationId || existing.requestFingerprint !== digest(raw))
        )
          reject('EVENT_CONTENT_CONFLICT', 409)
        if (existing)
          return { status: 'revoked', installationId, revokedAt: existing.at.toISOString() }
        const installation = await installations.findOne(
          { ...chainOf(body), installationId, authVersion: 1 },
          { session },
        )
        if (!installation) reject('NOT_FOUND', 404)
        if (!installation.active && installation.authorization === 'revoked') {
          const revokedAt = installation.revokedAt
          if (!revokedAt) reject('RECOVERY_REQUIRED', 409)
          await audit(
            actor,
            body,
            'installation-revoke',
            body.operationRequestId,
            digest(raw),
            installationId,
            'revoked',
            session,
            revokedAt,
          )
          return { status: 'revoked', installationId, revokedAt: revokedAt.toISOString() }
        }
        if (
          (
            await db
              .collection('chains')
              .updateOne(
                { ...chainOf(body), enrollmentGeneration: installation!.enrollmentGeneration },
                { $inc: { fence: 1 } },
                { session },
              )
          ).matchedCount !== 1
        )
          reject('ACCESS_REVOKED', 403)
        const revokedAt = installation!.revokedAt ?? new Date()
        await installations.updateOne(
          { ...chainOf(body), installationId },
          { $set: { active: false, authorization: 'revoked', revokedAt }, $inc: { fence: 1 } },
          { session },
        )
        await sessions.updateMany(
          { ...chainOf(body), installationId },
          { $set: { active: false }, $inc: { fence: 1 } },
          { session },
        )
        await audit(
          actor,
          body,
          'installation-revoke',
          body.operationRequestId,
          digest(raw),
          installationId,
          'revoked',
          session,
          revokedAt,
        )
        return { status: 'revoked', installationId, revokedAt: revokedAt.toISOString() }
      })
    },
  }
}
export type AuthService = ReturnType<typeof createAuthService>
