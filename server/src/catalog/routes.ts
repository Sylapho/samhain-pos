import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { Db, MongoClient } from 'mongodb'
import type { AuthService } from '../tablet-auth/service.ts'
import { bearer, proof } from '../tablet-auth/routes.ts'
import { keys, record, uuid } from '../tablet-auth/validation.ts'
import { scopeOf } from '../tablet-auth/guards.ts'
import { ApiError } from '../errors.ts'
import { PersistenceError } from '../persistence/errors.ts'
import { createPersistence } from '../persistence/store.ts'
import type { CatalogHead, CatalogVersion } from '../persistence/model.ts'
import { digest } from '../tablet-auth/crypto.ts'
import {
  MAX_CATALOG_BYTES,
  readCatalogVersion,
  validateCatalogContent,
} from './shared/catalogDistribution.ts'

function valid<T>(work: () => T): T {
  try {
    return work()
  } catch {
    throw new ApiError(422, 'INVALID_PAYLOAD')
  }
}

export function catalogRoutes(client: MongoClient, db: Db, auth: AuthService): FastifyPluginAsync {
  const store = createPersistence(client, db)
  return async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('X-Samhain-Destination', auth.config.destinationId)
      reply.header('Cache-Control', 'no-store')
    })
    // Signed POSTs bind the scope and read mode to the existing catalog-v1 proof.
    api.post('/catalog/active', async (request) => {
      const body = record(request.body)
      keys(
        body,
        ['organizationId', 'festivalId', 'installationId', 'chainId', 'enrollmentGeneration'],
        ['metadataOnly'],
      )
      if (body.metadataOnly !== undefined && typeof body.metadataOnly !== 'boolean')
        throw new ApiError(400, 'INVALID_ENVELOPE')
      return auth.protectedTablet(
        bearer(request),
        'catalog-v1',
        proof(request),
        async (state, session) => {
          const installation = state.installation
          for (const field of [
            'organizationId',
            'festivalId',
            'installationId',
            'chainId',
            'enrollmentGeneration',
          ] as const)
            if (body[field] !== installation[field]) throw new ApiError(403, 'SCOPE_DENIED')
          const scope = scopeOf(installation)
          const head = await db.collection<CatalogHead>('catalogHeads').findOne(scope, { session })
          if (!head || head.revision === 0) return { ...scope, version: null, publication: null }
          if (!head.versionId) throw new ApiError(503, 'CATALOG_UNAVAILABLE')
          const version = await db
            .collection<CatalogVersion>('catalogVersions')
            .findOne({ ...scope, versionId: head.versionId, revision: head.revision }, { session })
          if (!version || version.sha256 !== head.sha256)
            throw new ApiError(503, 'CATALOG_UNAVAILABLE')
          const envelope = { payload: version.payload, sha256: version.sha256 }
          try {
            readCatalogVersion(envelope, scope)
          } catch {
            throw new ApiError(503, 'CATALOG_UNAVAILABLE')
          }
          const publication = {
            ...scope,
            id: version.versionId,
            revision: version.revision,
            schemaVersion: version.schemaVersion,
            publishedAt: version.publishedAt.toISOString(),
            sha256: version.sha256,
          }
          return { ...scope, publication, ...(body.metadataOnly ? {} : { version: envelope }) }
        },
      )
    })
    api.post('/catalog/publications', { bodyLimit: MAX_CATALOG_BYTES }, async (request) => {
      const body = record(request.body)
      keys(body, [
        'organizationId',
        'festivalId',
        'expectedRevision',
        'schemaVersion',
        'products',
        'categories',
      ])
      const scope = { organizationId: uuid(body.organizationId), festivalId: uuid(body.festivalId) }
      const expected = body.expectedRevision
      if (
        body.schemaVersion !== 1 ||
        typeof expected !== 'number' ||
        !Number.isSafeInteger(expected) ||
        expected < 0 ||
        expected >= Number.MAX_SAFE_INTEGER
      )
        throw new ApiError(400, 'INVALID_ENVELOPE')
      valid(() => validateCatalogContent(body))
      try {
        return await auth.protectedManager(
          bearer(request),
          scope,
          'publish_catalog',
          async (actor, session) => {
            const publishedAt = new Date()
            const id = randomUUID()
            // Serialize exactly once. Store and transmit this same UTF-8 string.
            const payload = JSON.stringify({
              ...scope,
              id,
              revision: expected + 1,
              schemaVersion: 1,
              publishedAt: publishedAt.toISOString(),
              origin: `api:${actor.subject}`,
              products: body.products,
              categories: body.categories,
            })
            if (Buffer.byteLength(payload, 'utf8') > MAX_CATALOG_BYTES)
              throw new ApiError(413, 'CATALOG_TOO_LARGE')
            const version: CatalogVersion = {
              ...scope,
              documentSchemaVersion: 1,
              versionId: id,
              revision: expected + 1,
              schemaVersion: 1,
              payload,
              sha256: digest(payload),
              publishedAt,
              author: actor,
            }
            const envelope = await store.publishCatalog(
              scope,
              actor,
              expected,
              version,
              (value) => valid(() => validateCatalogContent(value)),
              { session },
            )
            return { version: envelope }
          },
        )
      } catch (error) {
        if (error instanceof PersistenceError && error.code === 'CATALOG_CONFLICT')
          throw new ApiError(409, 'CATALOG_HEAD_MOVED')
        throw error
      }
    })
  }
}
