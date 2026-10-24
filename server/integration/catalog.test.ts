import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { authFixture, candidate } from './auth-fixture.ts'
import { digest } from '../src/tablet-auth/crypto.ts'
import {
  readCatalogVersion,
  validateCatalogContent,
} from '../src/catalog/shared/catalogDistribution.ts'
import { transaction } from '../src/persistence/transactions.ts'
import { createPersistence } from '../src/persistence/store.ts'

const integration = {
  skip: !process.env.MONGODB_TEST_URI ? 'Disposable MongoDB unavailable' : false,
}
const content = {
  categories: [{ id: 'test', label: 'Test', active: true, displayOrder: 0 }],
  products: [
    {
      id: 'fixture',
      name: 'Test é / 🍀',
      categoryId: 'test',
      active: true,
      displayOrder: 0,
      requiresPreparation: false,
      availability: 'available',
      priceCents: 500,
      vatRate: 10,
      dataConfidence: 'confirmed',
    },
  ],
}
test(
  'catalog API: bootstrap, exact bytes, two tablets, CAS, history, permissions, revocation and rollback',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    const a = candidate(f),
      b = candidate(f)
    const ea = await a.enroll(scope),
      eb = await b.enroll(scope)
    const publish = (expectedRevision: number, changes = {}, token = f.manager) =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/catalog/publications',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...scope, ...content, schemaVersion: 1, expectedRevision, ...changes },
      })
    const read = (tablet = b, enrollment = eb, changes = {}) =>
      tablet.signed(
        '/api/v1/catalog/active',
        'catalog-v1',
        {
          ...scope,
          chainId: tablet.chainId,
          installationId: tablet.installationId,
          enrollmentGeneration: enrollment.enrollmentGeneration,
          ...changes,
        },
        enrollment.session.access_token,
      )
    assert.equal((await read()).json().version, null)
    assert.equal((await publish(0)).statusCode, 403, 'manage_enrollment alone cannot publish')
    await f.db.collection('scopeGrants').insertOne({
      documentSchemaVersion: 1,
      ...scope,
      issuer: f.configuration.oidc!.issuer,
      subject: 'test-manager',
      capability: 'publish_catalog',
      active: true,
      fence: 0,
    })
    const first = await publish(0)
    assert.equal(first.statusCode, 200, first.body)
    const version = first.json().version
    assert.equal(digest(Buffer.from(version.payload, 'utf8')), version.sha256)
    assert.equal(readCatalogVersion(version, scope).revision, 1)
    assert.deepEqual((await read(a, ea)).json().version, version)
    assert.deepEqual((await read()).json().version, version)
    const meta = await read(b, eb, { metadataOnly: true })
    assert.equal(meta.json().publication.revision, 1)
    assert.equal(meta.json().version, undefined)
    await f.db.collection('scopeGrants').insertOne({
      documentSchemaVersion: 1,
      ...scope,
      issuer: f.configuration.oidc!.issuer,
      subject: 'second-publisher',
      capability: 'publish_catalog',
      active: true,
      fence: 0,
    })
    const secondManager = await f.managerToken('second-publisher')
    const races = await Promise.all([publish(1), publish(1, {}, secondManager)])
    assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409])
    assert.equal((await publish(0)).statusCode, 409)
    assert.equal(await f.db.collection('catalogVersions').countDocuments(), 2)
    assert.deepEqual(
      (await f.db.collection('catalogVersions').findOne({ revision: 1 }))?.payload,
      version.payload,
    )
    assert.equal((await read()).json().publication.revision, 2)
    const head = await f.db.collection('catalogHeads').findOne(scope)
    const forgedPayload = JSON.stringify({
      ...JSON.parse(version.payload),
      id: randomUUID(),
      revision: 3,
    })
    await assert.rejects(
      createPersistence(f.client, f.db).publishCatalog(
        scope,
        { issuer: f.configuration.oidc!.issuer, subject: 'test-manager' },
        2,
        {
          documentSchemaVersion: 1,
          ...scope,
          versionId: JSON.parse(forgedPayload).id,
          revision: 3,
          schemaVersion: 1,
          payload: forgedPayload,
          sha256: '0'.repeat(64),
          publishedAt: new Date(JSON.parse(version.payload).publishedAt),
          author: { issuer: f.configuration.oidc!.issuer, subject: 'test-manager' },
        },
        validateCatalogContent,
      ),
      (error: unknown) => error instanceof Error && error.message === 'INVALID_DOCUMENT',
    )
    let insertedBeforeFailure = false
    await assert.rejects(
      transaction(f.client, async (session) => {
        const publication = { ...JSON.parse(version.payload), id: randomUUID(), revision: 3 }
        const payload = JSON.stringify(publication)
        await createPersistence(f.client, f.db).publishCatalog(
          scope,
          { issuer: f.configuration.oidc!.issuer, subject: 'test-manager' },
          2,
          {
            documentSchemaVersion: 1,
            ...scope,
            versionId: publication.id,
            revision: 3,
            schemaVersion: 1,
            payload,
            sha256: digest(payload),
            publishedAt: new Date(publication.publishedAt),
            author: { issuer: f.configuration.oidc!.issuer, subject: 'test-manager' },
          },
          validateCatalogContent,
          { session },
        )
        assert.equal(
          await f.db.collection('catalogVersions').countDocuments({ revision: 3 }, { session }),
          1,
        )
        insertedBeforeFailure = true
        throw new Error('injected rollback')
      }),
    )
    assert.deepEqual(await f.db.collection('catalogHeads').findOne(scope), head)
    assert.equal(insertedBeforeFailure, true)
    assert.equal(await f.db.collection('catalogVersions').countDocuments(), 2)
    const invalid = [
      { products: [{ ...content.products[0], dataConfidence: 'temporary' }] },
      { products: [content.products[0], content.products[0]] },
      { products: [{ ...content.products[0], priceCents: -1 }] },
      { products: [{ ...content.products[0], vatRate: 7 }] },
      { products: [{ ...content.products[0], categoryId: 'absent' }] },
      { categories: [content.categories[0], { ...content.categories[0], id: 'other' }] },
      { products: [{ ...content.products[0], name: '' }] },
      { products: [{ ...content.products[0], priceCents: undefined }] },
    ]
    for (const changes of invalid) assert.equal((await publish(2, changes)).statusCode, 422)
    assert.equal((await publish(2, { schemaVersion: 2 })).statusCode, 400)
    assert.equal((await publish(2, { expectedRevision: -1 })).statusCode, 400)
    assert.equal(
      (
        await publish(2, {
          products: [{ ...content.products[0], description: 'x'.repeat(450001) }],
        })
      ).statusCode,
      413,
    )
    assert.equal((await publish(2, { festivalId: randomUUID() })).statusCode, 403)
    assert.equal((await publish(2, { organizationId: randomUUID() })).statusCode, 403)
    assert.equal((await publish(2, {}, ea.session.access_token)).statusCode, 401)
    assert.equal((await read(b, eb, { festivalId: randomUUID() })).statusCode, 403)
    assert.equal((await read(b, eb, { organizationId: randomUUID() })).statusCode, 403)
    await f.db
      .collection('scopeGrants')
      .updateOne({ ...scope, capability: 'publish_catalog' }, { $set: { active: false } })
    assert.equal((await publish(2)).statusCode, 403)
    for (const [tablet, enrollment, update] of [
      [b, eb, { active: false }],
      [a, ea, { expiresAt: new Date(0) }],
    ] as const) {
      const body = {
        ...scope,
        installationId: tablet.installationId,
        chainId: tablet.chainId,
        enrollmentGeneration: enrollment.enrollmentGeneration,
      }
      const signed = await tablet.proof('catalog-v1', body)
      await f.db
        .collection('apiSessions')
        .updateMany({ installationId: tablet.installationId }, { $set: update })
      const refused = await f.app.inject({
        method: 'POST',
        url: '/api/v1/catalog/active',
        payload: signed.raw,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${enrollment.session.access_token}`,
          'x-samhain-nonce': signed.nonce,
          'x-samhain-signature': signed.signature,
        },
      })
      assert.equal(refused.statusCode, 401, refused.body)
    }
    assert.equal(await f.db.collection('catalogVersions').countDocuments(), 2)
    assert.equal(await f.db.collection('ledgerEvents').countDocuments(), 0)
  },
)

test(
  'catalog unavailable MongoDB returns controlled retry without credentials',
  integration,
  async (t) => {
    const f = await authFixture()
    t.after(() => f.close())
    const scope = await f.scope()
    await f.client.close()
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/catalog/publications',
      headers: { authorization: `Bearer ${f.manager}` },
      payload: { ...scope, ...content, schemaVersion: 1, expectedRevision: 0 },
    })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { error: { code: 'TRANSACTION_RETRY' } })
  },
)
