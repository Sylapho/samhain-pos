import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { createLocalJWKSet, exportJWK, importPKCS8, SignJWT } from 'jose'
import { authCrypto, digest, verifyProof } from '../src/tablet-auth/crypto.ts'
import { loadAuthConfig } from '../src/tablet-auth/config.ts'
import { dossier } from '../src/tablet-auth/validation.ts'
import type { AuthConfig } from '../src/tablet-auth/config.ts'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
export const authConfig: AuthConfig = {
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
    redirectUri: 'fr.samhain.witches:/oauth2redirect',
    scopes: 'openid test-api',
    maxAgeSeconds: 3600,
  },
}

test('auth defaults to disabled and partially configured OIDC fails closed without logging values', () => {
  assert.equal(loadAuthConfig({}), null)
  assert.throws(() => loadAuthConfig({ API_AUTH_ENABLED: 'true' }), /API_JWT_ISSUER/)
  assert.throws(() => loadAuthConfig({ API_AUTH_ENABLED: 'unsafe' }), /API_AUTH_ENABLED/)
})
test('installation proof covers exact bytes, action, installation and nonce', () => {
  const id = randomUUID()
  const nonce = randomBytes(32).toString('base64url')
  const raw = Buffer.from('{"installationId":"' + id + '"}')
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`samhain-auth/1\n${id}\nstatus\n${nonce}\n${digest(raw)}`),
    pair.privateKey,
  ).toString('base64')
  verifyProof(id, 'status', nonce, raw, signature, spki)
  for (const [otherId, action, body] of [
    [randomUUID(), 'status', raw],
    [id, 'refresh', raw],
    [id, 'status', Buffer.from(raw.toString() + ' ')],
  ] as const)
    assert.throws(() => verifyProof(otherId, action, nonce, body, signature, spki))
})
test('JWT issuer/audience/algorithm/expiry and encryption purpose are enforced', async () => {
  const key = await importPKCS8(privatePem, 'RS256')
  const jwk = await exportJWK(pair.publicKey)
  const crypto = await authCrypto(authConfig, {
    privateKeyPem: privatePem,
    encryptionKey: randomBytes(32),
    oidcKeys: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-oidc', alg: 'RS256' }] }),
  })
  const now = Math.floor(Date.now() / 1000)
  const jwt = async (issuer: string, audience: string, expires = now + 60) =>
    new SignJWT({ sub: 'manager', iat: now, exp: expires })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-oidc' })
      .setIssuer(issuer)
      .setAudience(audience)
      .sign(key)
  assert.deepEqual(
    await crypto.manager(await jwt(authConfig.oidc!.issuer, authConfig.oidc!.audience)),
    { issuer: authConfig.oidc!.issuer, subject: 'manager' },
  )
  await assert.rejects(
    crypto.manager(await jwt('https://wrong.example.invalid', authConfig.oidc!.audience)),
  )
  await assert.rejects(crypto.manager(await jwt(authConfig.oidc!.issuer, 'wrong')))
  await assert.rejects(
    crypto.manager(await jwt(authConfig.oidc!.issuer, authConfig.oidc!.audience, now - 30)),
  )
  const data = { refresh_token: 'test-only' }
  const sealed = crypto.seal(data, 'rotation:one')
  assert(!sealed.includes('test-only'))
  assert.deepEqual(crypto.open(sealed, 'rotation:one'), data)
  assert.throws(() => crypto.open(sealed, 'rotation:other'))
  const claims = {
    sub: randomUUID(),
    sid: randomUUID(),
    jti: randomUUID(),
    organizationId: randomUUID(),
    festivalId: randomUUID(),
    chainId: randomUUID(),
    enrollmentGeneration: 1,
  }
  assert.equal((await crypto.session(await crypto.sign(claims, now))).sid, claims.sid)
  await assert.rejects(crypto.session(await crypto.sign(claims, now - 1200)))
})
test('dossier parsing refuses truncated, duplicate and extra context without changing historical IDs', () => {
  const value = {
    chainId: randomUUID(),
    restored: false,
    terminalId: 'opaque/terminal',
    prefix: [
      { sequence: 1, eventId: 'sale:opaque', hash: 'a'.repeat(64), terminalId: 'opaque/terminal' },
    ],
    legacyOrderIds: ['legacy:opaque'],
  }
  assert.deepEqual(dossier(value), value)
  assert.throws(() => dossier({ ...value, prefix: [{ ...value.prefix[0], sequence: 2 }] }))
  assert.throws(() => dossier({ ...value, organizationId: randomUUID() }))
  assert.throws(() => dossier({ ...value, legacyOrderIds: ['same', 'same'] }))
})
