import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { createLocalJWKSet, exportJWK, importPKCS8, SignJWT } from 'jose'
import assert from 'node:assert/strict'
import { fixture } from './fixture.ts'
import { createAuthService } from '../src/tablet-auth/service.ts'
import { authCrypto, digest } from '../src/tablet-auth/crypto.ts'
import { buildApp } from '../src/app.ts'
import { config, fakeDatabase } from '../tests/helpers.ts'
import type { AuthConfig } from '../src/tablet-auth/config.ts'
import type { Dossier, SessionReply } from '../src/tablet-auth/types.ts'

export async function authFixture() {
  const f = await fixture()
  const serverKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const oidcKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const configuration: AuthConfig = {
    destinationId: '11111111-1111-4111-8111-111111111111',
    issuer: 'https://api.example.invalid',
    audience: 'test-api',
    keyId: 'test-key',
    privateKeyFile: 'unused',
    encryptionKeyFile: 'unused',
    accessSeconds: 600,
    idleDays: 30,
    absoluteDays: 90,
    oidc: {
      issuer: 'https://oidc.example.invalid',
      audience: 'test-managers',
      jwksUri: 'https://oidc.example.invalid/jwks',
      algorithm: 'RS256',
      clientId: 'test-native',
      authorizationEndpoint: 'https://oidc.example.invalid/authorize',
      tokenEndpoint: 'https://oidc.example.invalid/token',
      redirectUri: 'fr.samhain.pos:/oauth2redirect',
      scopes: 'openid test-api',
      maxAgeSeconds: 3600,
    },
  }
  const jwk = await exportJWK(oidcKey.publicKey)
  const crypto = await authCrypto(configuration, {
    privateKeyPem: serverKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    encryptionKey: randomBytes(32),
    oidcKeys: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-oidc', alg: 'RS256' }] }),
  })
  const service = createAuthService(f.client, f.db, configuration, crypto)
  const app = await buildApp(config(), { database: fakeDatabase(), authService: service })
  const oidcPrivate = await importPKCS8(
    oidcKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'RS256',
  )
  const subject = 'test-manager'
  const now = Math.floor(Date.now() / 1000)
  const manager = await new SignJWT({ sub: subject, iat: now, exp: now + 3600 })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-oidc' })
    .setIssuer(configuration.oidc!.issuer)
    .setAudience(configuration.oidc!.audience)
    .sign(oidcPrivate)
  async function scope() {
    const value = { organizationId: randomUUID(), festivalId: randomUUID() }
    await f.db.collection('organizations').insertOne({
      documentSchemaVersion: 1,
      organizationId: value.organizationId,
      active: true,
      fence: 0,
    })
    await f.db
      .collection('festivals')
      .insertOne({ documentSchemaVersion: 1, ...value, active: true, fence: 0 })
    await f.db.collection('scopeGrants').insertOne({
      documentSchemaVersion: 1,
      ...value,
      issuer: configuration.oidc!.issuer,
      subject,
      capability: 'manage_enrollment',
      active: true,
      fence: 0,
    })
    return value
  }
  return {
    ...f,
    app,
    service,
    manager,
    configuration,
    scope,
    async close() {
      await app.close()
      await f.client.close()
    },
  }
}
export type AuthFixture = Awaited<ReturnType<typeof authFixture>>
export function candidate(f: AuthFixture, chainId = randomUUID(), extra: Partial<Dossier> = {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const installationId = randomUUID()
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const dossier: Dossier = {
    chainId,
    terminalId: 'test-terminal',
    restored: false,
    prefix: [],
    legacyOrderIds: [],
    ...extra,
  }
  const operationRequestId = randomUUID()
  const body = { operationRequestId, installationId, publicKey, dossier }
  async function proof(action: string, value: unknown, requestId?: string) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/challenges',
      payload: { installationId, publicKey, action, ...(requestId ? { requestId } : {}) },
    })
    assert.equal(response.statusCode, 200, response.body)
    const nonce = response.json<{ nonce: string }>().nonce
    const raw = Buffer.from(JSON.stringify(value))
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(`samhain-auth/1\n${installationId}\n${action}\n${nonce}\n${digest(raw)}`),
      key.privateKey,
    ).toString('base64')
    return { nonce, signature, raw }
  }
  async function signed(
    url: string,
    action: string,
    value: unknown,
    token?: string,
    requestId?: string,
  ) {
    const p = await proof(action, value, requestId)
    return f.app.inject({
      method: 'POST',
      url,
      payload: p.raw,
      headers: {
        'content-type': 'application/json',
        'x-samhain-nonce': p.nonce,
        'x-samhain-signature': p.signature,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
  }
  async function request() {
    const response = await signed('/api/v1/tablet-enrollments', 'request', body)
    assert.equal(response.statusCode, 200, response.body)
    return response.json<{ requestId: string; status: string }>()
  }
  async function decision(
    requestId: string,
    scope: { organizationId: string; festivalId: string },
    decision: 'approve' | 'reject' = 'approve',
    replacesInstallationId?: string,
  ) {
    return f.app.inject({
      method: 'POST',
      url: `/api/v1/tablet-enrollments/${requestId}/decision`,
      headers: { authorization: `Bearer ${f.manager}` },
      payload: {
        ...scope,
        chainId,
        operationRequestId: randomUUID(),
        decision,
        ...(replacesInstallationId ? { replacesInstallationId } : {}),
      },
    })
  }
  async function enroll(
    scope: { organizationId: string; festivalId: string },
    replacesInstallationId?: string,
  ) {
    const requested = await request()
    const approved = await decision(requested.requestId, scope, 'approve', replacesInstallationId)
    assert.equal(approved.statusCode, 200, approved.body)
    const value = {
      installationId,
      operationRequestId: randomUUID(),
      invitationCode: approved.json<{ invitationCode: string }>().invitationCode,
    }
    const activated = await signed(
      `/api/v1/tablet-enrollments/${requested.requestId}/activate`,
      'activate',
      value,
      undefined,
      requested.requestId,
    )
    assert.equal(activated.statusCode, 200, activated.body)
    return {
      ...activated.json<{ status: string; session: SessionReply; enrollmentGeneration: number }>(),
      requestId: requested.requestId,
      activationBody: value,
    }
  }
  return { installationId, publicKey, key, chainId, body, proof, signed, request, decision, enroll }
}
