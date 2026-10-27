import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { AuthService } from './service.ts'
import type { AuthChallenge, Scope } from '../persistence/model.ts'
import { dossier, keys, record, text, uuid } from './validation.ts'
import { reject } from './crypto.ts'

export function bearer(request: FastifyRequest, optional = false) {
  const value = request.headers.authorization
  if (!value && optional) return ''
  if (!value || !/^Bearer [A-Za-z0-9._~-]+$/.test(value) || value.length > 16384) return reject()
  return value.slice(7)
}
export function proof(request: FastifyRequest) {
  const nonce = request.headers['x-samhain-nonce']
  const signature = request.headers['x-samhain-signature']
  if (typeof nonce !== 'string' || typeof signature !== 'string' || !request.rawBody)
    return reject('PROOF_REQUIRED', 403)
  return { nonce, signature, raw: request.rawBody }
}
const scope = (value: Record<string, unknown>): Scope => ({
  organizationId: uuid(value.organizationId),
  festivalId: uuid(value.festivalId),
})
export function authRoutes(service: AuthService): FastifyPluginAsync {
  return async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('X-Samhain-Destination', service.config.destinationId)
    })
    api.get('/auth/config', async () => ({
      protocolVersion: 1,
      destinationId: service.config.destinationId,
    }))
    api.get('/auth/oidc-config', async () => {
      const config = service.config.oidc
      if (!config) return reject('OIDC_NOT_CONFIGURED', 503)
      return {
        issuer: config.issuer,
        clientId: config.clientId,
        authorizationEndpoint: config.authorizationEndpoint,
        tokenEndpoint: config.tokenEndpoint,
        redirectUri: config.redirectUri,
        scopes: config.scopes.split(/\s+/),
      }
    })
    api.get('/auth/manager', async (request) => {
      const actor = await service.crypto.manager(bearer(request))
      // Identity only; each administrative action rechecks the live scoped grant in its transaction.
      return { authenticated: true, issuer: actor.issuer, subject: actor.subject }
    })
    api.post('/auth/challenges', async (request) => {
      const body = record(request.body)
      keys(body, ['installationId', 'action'], ['publicKey', 'requestId'])
      const action = text(body.action)
      if (
        ![
          'request',
          'activate',
          'status',
          'refresh',
          'authorize',
          'ledger-ingest-v1',
          'legacy-import-v1',
          'ledger-prefix-v1',
          'catalog-v1',
        ].includes(action)
      )
        return reject('INVALID_ENVELOPE', 400)
      return service.challenge({
        installationId: uuid(body.installationId),
        action: action as AuthChallenge['action'],
        ...('publicKey' in body ? { publicKey: text(body.publicKey, 2000) } : {}),
        ...('requestId' in body ? { requestId: uuid(body.requestId) } : {}),
      })
    })
    api.post('/tablet-enrollments', async (request) => {
      const body = record(request.body)
      keys(
        body,
        ['operationRequestId', 'installationId', 'publicKey', 'dossier'],
        ['organizationId', 'festivalId'],
      )
      const requested = 'organizationId' in body || 'festivalId' in body ? scope(body) : undefined
      return service.request(
        {
          operationRequestId: uuid(body.operationRequestId),
          installationId: uuid(body.installationId),
          publicKey: text(body.publicKey, 2000),
          dossier: dossier(body.dossier),
          ...(requested ? { requestedScope: requested } : {}),
        },
        proof(request),
      )
    })
    api.get('/tablet-enrollments', async (request) => {
      const query = record(request.query)
      keys(query, ['organizationId', 'festivalId'], ['cursor', 'limit'])
      const limit = query.limit === undefined ? 50 : Number(query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return reject('INVALID_ENVELOPE', 400)
      return service.list(
        bearer(request),
        scope(query),
        query.cursor === undefined ? undefined : text(query.cursor, 4096),
        limit,
      )
    })
    api.get('/tablet-enrollments/:requestId', async (request) => {
      const params = record(request.params)
      const query = record(request.query)
      keys(query, ['organizationId', 'festivalId'])
      return service.detail(bearer(request), scope(query), uuid(params.requestId))
    })
    api.post('/tablet-enrollments/:requestId/decision', async (request) => {
      const params = record(request.params)
      const body = record(request.body)
      keys(
        body,
        ['operationRequestId', 'decision', 'organizationId', 'festivalId', 'chainId'],
        ['replacesInstallationId'],
      )
      if (body.decision !== 'approve' && body.decision !== 'reject')
        return reject('INVALID_ENVELOPE', 400)
      return service.decide(
        bearer(request),
        uuid(params.requestId),
        {
          ...scope(body),
          operationRequestId: uuid(body.operationRequestId),
          decision: body.decision,
          chainId: uuid(body.chainId),
          ...('replacesInstallationId' in body
            ? { replacesInstallationId: uuid(body.replacesInstallationId) }
            : {}),
        },
        request.rawBody!,
      )
    })
    api.post('/tablet-enrollments/:requestId/activate', async (request) => {
      const params = record(request.params)
      const body = record(request.body)
      keys(body, ['operationRequestId', 'installationId', 'invitationCode'])
      return service.activate(
        uuid(params.requestId),
        {
          operationRequestId: uuid(body.operationRequestId),
          installationId: uuid(body.installationId),
          invitationCode: text(body.invitationCode, 256),
        },
        proof(request),
      )
    })
    api.post('/tablets/status', async (request) => {
      const body = record(request.body)
      keys(body, ['installationId'], ['requestId'])
      const token = bearer(request, true)
      if (!token) {
        if (!body.requestId) return reject()
        return service.pendingStatus(
          uuid(body.requestId),
          uuid(body.installationId),
          proof(request),
        )
      }
      if (body.requestId) return reject('INVALID_ENVELOPE', 400)
      return service.status(token, uuid(body.installationId), proof(request))
    })
    api.post('/auth/refresh', async (request) => {
      const body = record(request.body)
      keys(body, ['installationId', 'refresh_token', 'rotationId'])
      return service.refresh(
        {
          installationId: uuid(body.installationId),
          refresh_token: text(body.refresh_token, 512),
          rotationId: uuid(body.rotationId),
        },
        proof(request),
      )
    })
    api.post('/tablets/:installationId/revoke', async (request) => {
      const params = record(request.params)
      const body = record(request.body)
      keys(body, ['operationRequestId', 'organizationId', 'festivalId', 'chainId'])
      return service.revoke(
        bearer(request),
        uuid(params.installationId),
        {
          ...scope(body),
          chainId: uuid(body.chainId),
          operationRequestId: uuid(body.operationRequestId),
        },
        request.rawBody!,
      )
    })
  }
}
