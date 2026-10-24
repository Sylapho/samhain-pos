import { readFile } from 'node:fs/promises'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from 'jose'
import type { JWTVerifyGetKey, JWTPayload, CryptoKey } from 'jose'
import type { AuthConfig } from './config.ts'
import { ApiError } from '../errors.ts'

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const secret = () => randomBytes(32).toString('base64url')
export function reject(code = 'AUTH_REQUIRED', status = 401): never {
  throw new ApiError(status, code)
}
export function publicKey(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 2000) reject('INVALID_ENVELOPE', 400)
  try {
    const der = Buffer.from(value, 'base64')
    if (der.toString('base64') !== value) reject('INVALID_ENVELOPE', 400)
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      reject('INVALID_ENVELOPE', 400)
    return key
  } catch {
    return reject('INVALID_ENVELOPE', 400)
  }
}
export function verifyProof(
  installationId: string,
  action: string,
  nonce: string,
  raw: Buffer,
  signature: string,
  spki: string,
) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
    signature.length > 2000
  )
    reject('PROOF_REQUIRED', 403)
  const message = `samhain-auth/1\n${installationId}\n${action}\n${nonce}\n${digest(raw)}`
  if (
    !verify('RSA-SHA256', Buffer.from(message), publicKey(spki), Buffer.from(signature, 'base64'))
  )
    reject('PROOF_REQUIRED', 403)
}
export function sameHash(value: string, expected: string): boolean {
  const actual = Buffer.from(digest(value), 'hex')
  const wanted = Buffer.from(expected, 'hex')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
export type SessionClaims = JWTPayload & {
  sid: string
  organizationId: string
  festivalId: string
  chainId: string
  enrollmentGeneration: number
}

async function boundedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  })
  if (!response.body) return response
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > 131072) throw new Error('JWKS too large')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers })
}

export async function authCrypto(
  config: AuthConfig,
  supplied?: { privateKeyPem: string; encryptionKey: Buffer; oidcKeys?: JWTVerifyGetKey },
) {
  const signing = await importPKCS8(
    supplied?.privateKeyPem ?? (await readFile(config.privateKeyFile, 'utf8')),
    'RS256',
  )
  const pem = supplied?.privateKeyPem ?? (await readFile(config.privateKeyFile, 'utf8'))
  const publicPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()
  const { importSPKI } = await import('jose')
  const verifying: CryptoKey = await importSPKI(publicPem, 'RS256')
  const encryptionKey =
    supplied?.encryptionKey ??
    Buffer.from((await readFile(config.encryptionKeyFile, 'utf8')).trim(), 'base64')
  if (encryptionKey.length !== 32) throw new Error('Invalid auth encryption configuration')
  const oidcKeys =
    supplied?.oidcKeys ??
    (config.oidc
      ? createRemoteJWKSet(new URL(config.oidc.jwksUri), {
          timeoutDuration: 3000,
          cooldownDuration: 30000,
          cacheMaxAge: 600000,
          [customFetch]: boundedFetch,
        })
      : null)
  return {
    seal(value: unknown, purpose: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
      cipher.setAAD(Buffer.from(purpose))
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url')
    },
    open(value: string, purpose: string): unknown {
      try {
        const bytes = Buffer.from(value, 'base64url')
        const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12))
        cipher.setAAD(Buffer.from(purpose))
        cipher.setAuthTag(bytes.subarray(12, 28))
        return JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
        )
      } catch {
        return reject('RECOVERY_REQUIRED', 409)
      }
    },
    async sign(claims: SessionClaims, now: number) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: config.keyId, typ: 'at+jwt' })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + config.accessSeconds)
        .sign(signing)
    },
    async session(token: string): Promise<SessionClaims> {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, verifying, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['RS256'],
          typ: 'at+jwt',
          requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
          maxTokenAge: config.accessSeconds,
          clockTolerance: 5,
        })
        if (
          protectedHeader.kid !== config.keyId ||
          typeof payload.sub !== 'string' ||
          typeof payload.sid !== 'string' ||
          typeof payload.jti !== 'string' ||
          typeof payload.organizationId !== 'string' ||
          typeof payload.festivalId !== 'string' ||
          typeof payload.chainId !== 'string' ||
          !Number.isSafeInteger(payload.enrollmentGeneration) ||
          Number(payload.enrollmentGeneration) < 1
        )
          return reject()
        return payload as SessionClaims
      } catch {
        return reject()
      }
    },
    async manager(token: string) {
      if (!config.oidc || !oidcKeys) return reject('OIDC_NOT_CONFIGURED', 503)
      try {
        const { payload } = await jwtVerify(token, oidcKeys, {
          issuer: config.oidc.issuer,
          audience: config.oidc.audience,
          algorithms: [config.oidc.algorithm],
          requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'],
          maxTokenAge: config.oidc.maxAgeSeconds,
          clockTolerance: 5,
        })
        if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512)
          return reject()
        return { issuer: config.oidc.issuer, subject: payload.sub }
      } catch {
        return reject()
      }
    },
  }
}
export type AuthCrypto = Awaited<ReturnType<typeof authCrypto>>
