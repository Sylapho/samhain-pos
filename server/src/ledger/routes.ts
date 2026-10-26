import type { FastifyPluginAsync } from 'fastify'
import type { Db, MongoClient } from 'mongodb'
import type { AuthService } from '../tablet-auth/service.ts'
import { bearer, proof } from '../tablet-auth/routes.ts'
import { chainOf } from '../tablet-auth/guards.ts'
import { createPersistence } from '../persistence/store.ts'
import type { TabletContext } from '../persistence/store.ts'
import type { LedgerEvent, SyncReceipt } from '../persistence/model.ts'
import type { AuthEnrollment } from '../tablet-auth/types.ts'
import { digest } from '../tablet-auth/crypto.ts'
import { parseStrictJson } from '../json.ts'
import { ApiError } from '../errors.ts'
import { validateRequest } from './protocol.ts'
import type { Tuple } from './protocol.ts'
import { validateBusiness, validateOrder, validatePayload } from './business.ts'
import { array, fail, object } from './validation.ts'
import { ledgerFailure } from './errors.ts'

export function ledgerRoutes(client: MongoClient, db: Db, auth: AuthService): FastifyPluginAsync {
  const store = createPersistence(client, db)
  return async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('X-Samhain-Destination', auth.config.destinationId)
    })
    for (const endpoint of ['ingest', 'legacy', 'prefix'] as const) {
      api.post(`/ledger/${endpoint}`, async (request) => {
        try {
          const token = bearer(request),
            signed = proof(request)
          const signal = AbortSignal.any([request.operationSignal, AbortSignal.timeout(15000)])
          const ingest = endpoint === 'ingest' ? validateRequest(request.body, 'ingest') : null
          const legacy = endpoint === 'legacy' ? validateRequest(request.body, 'legacy') : null
          const prefix = endpoint === 'prefix' ? validateRequest(request.body, 'prefix') : null
          const body = ingest ?? legacy ?? prefix!
          for (const event of ingest?.events ?? [])
            validatePayload(parseStrictJson(event.payloadCanonical))
          for (const event of legacy?.events ?? [])
            validateOrder(parseStrictJson(event.payloadCanonical), event.sourceTerminalId)
          const responseContext = {
            protocolVersion: 1 as const,
            requestId: body.requestId,
            ...chainOf(body),
          }
          const action =
            endpoint === 'ingest'
              ? 'ledger-ingest-v1'
              : endpoint === 'legacy'
                ? 'legacy-import-v1'
                : 'ledger-prefix-v1'
          return await auth.protectedTablet(
            token,
            action,
            signed,
            async (state, session) => {
              const installation = state.installation
              if (
                body.organizationId !== installation.organizationId ||
                body.festivalId !== installation.festivalId ||
                body.chainId !== installation.chainId ||
                body.installationId !== installation.installationId
              )
                fail('SCOPE_DENIED', 403)
              if (body.enrollmentGeneration !== installation.enrollmentGeneration)
                fail('INSTALLATION_RETIRED', 403)
              const context: TabletContext = {
                ...chainOf(installation),
                installationId: installation.installationId,
                enrollmentGeneration: installation.enrollmentGeneration,
                issuer: state.apiSession.issuer,
                subject: state.apiSession.subject,
                sessionId: state.apiSession.sessionId,
                keyFingerprint: state.apiSession.keyFingerprint,
                nonceHash: digest(signed.nonce),
                requestId: body.requestId,
              }
              if (endpoint === 'prefix') {
                const results = []
                for (const tuple of prefix!.events) {
                  signal.throwIfAborted()
                  const remote = await db
                    .collection<LedgerEvent>('ledgerEvents')
                    .findOne({ ...chainOf(installation), sequence: tuple.sequence }, { session })
                  if (!remote) {
                    results.push({ ...tuple, status: 'absent' as const })
                    continue
                  }
                  const server: Tuple = {
                    sequence: remote.sequence,
                    eventId: remote.eventId,
                    hash: remote.hash,
                    transportFingerprint: remote.transportFingerprint,
                  }
                  const match =
                    tuple.eventId === server.eventId &&
                    tuple.hash === server.hash &&
                    tuple.transportFingerprint === server.transportFingerprint
                  results.push({
                    ...tuple,
                    status: match ? ('match' as const) : ('conflict' as const),
                    ...(match ? {} : { server }),
                  })
                }
                return { ...responseContext, serverHead: state.chain.head, results }
              }
              const result =
                endpoint === 'ingest'
                  ? await store.persistLedger(
                      context,
                      ingest!.expectedHead,
                      ingest!.events,
                      validateBusiness,
                      { chain: state.chain, session, signal },
                    )
                  : await store.persistLegacyBatch(
                      context,
                      legacy!.events,
                      async (event) => {
                        // Bind unsealed orders to the explicitly approved enrollment inventory.
                        const dossier = await db
                          .collection<AuthEnrollment>('enrollmentRequests')
                          .findOne(
                            {
                              installationId: installation.installationId,
                              authVersion: 1,
                              status: 'activated',
                              'approvedScope.organizationId': installation.organizationId,
                              'approvedScope.festivalId': installation.festivalId,
                              'approvedScope.chainId': installation.chainId,
                            },
                            { session },
                          )
                        if (
                          !dossier ||
                          !array(
                            object(parseStrictJson(dossier.dossierCanonical)).legacyOrderIds,
                          ).includes(event.eventId)
                        )
                          fail('SCOPE_DENIED', 403)
                      },
                      { chain: state.chain, session, signal },
                    )
              return {
                ...responseContext,
                committed: true as const,
                serverHead: result.head,
                acknowledgements: result.receipts.map((receipt, index) =>
                  acknowledgement(receipt, result.statuses[index]!),
                ),
              }
            },
            endpoint === 'prefix',
            signal,
          )
        } catch (error) {
          const failure = ledgerFailure(error)
          throw new ApiError(failure.status, failure.code)
        }
      })
    }
  }
}

function acknowledgement(receipt: SyncReceipt, status: 'accepted' | 'already_present') {
  return {
    eventId: receipt.eventId,
    sequence: receipt.sequence,
    hash: receipt.hash,
    transportFingerprint: receipt.transportFingerprint,
    receiptId: receipt.receiptId,
    serverReceivedAt: receipt.serverReceivedAt.toISOString(),
    status,
  }
}
