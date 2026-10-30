import { isAbsolute } from 'node:path'
import { ConfigurationError } from '../config.ts'

export type OidcConfig = {
  issuer: string
  audience: string
  jwksUri: string
  algorithm: 'RS256' | 'ES256'
  clientId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  redirectUri: string
  scopes: string
  maxAgeSeconds: number
}
export type AuthConfig = {
  destinationId: string
  issuer: string
  audience: string
  keyId: string
  privateKeyFile: string
  encryptionKeyFile: string
  accessSeconds: number
  idleDays: number
  absoluteDays: number
  oidc: OidcConfig | null
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const fail = (name: string): never => {
    throw new ConfigurationError(`Invalid server configuration: ${name}`)
  }
  if (env.API_AUTH_ENABLED !== 'true') {
    if (env.API_AUTH_ENABLED && env.API_AUTH_ENABLED !== 'false') fail('API_AUTH_ENABLED')
    return null
  }
  const required = (name: string) => env[name]?.trim() || fail(name)
  const url = (name: string) => {
    const value = required(name)
    try {
      const parsed = new URL(value)
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        fail(name)
    } catch {
      fail(name)
    }
    return value
  }
  const file = (name: string) => {
    const value = required(name)
    if (!isAbsolute(value)) fail(name)
    return value
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isInteger(value) || value < min || value > max) fail(name)
    return value
  }
  const issuer = url('API_JWT_ISSUER')
  const destinationId = required('API_DESTINATION_ID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(destinationId))
    fail('API_DESTINATION_ID')
  const keyId = required('API_SIGNING_KEY_ID')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) fail('API_SIGNING_KEY_ID')
  let oidc: OidcConfig | null = null
  if (Object.keys(env).some((key) => key.startsWith('OIDC_') && env[key])) {
    const algorithm = required('OIDC_ALGORITHM')
    if (algorithm !== 'RS256' && algorithm !== 'ES256') fail('OIDC_ALGORITHM')
    const redirectUri = required('OIDC_REDIRECT_URI')
    if (redirectUri !== 'fr.samhain.witches:/oauth2redirect') fail('OIDC_REDIRECT_URI')
    const scopes = required('OIDC_SCOPES')
    if (!scopes.split(' ').includes('openid') || scopes.length > 512) fail('OIDC_SCOPES')
    oidc = {
      issuer: url('OIDC_ISSUER'),
      audience: required('OIDC_AUDIENCE'),
      jwksUri: url('OIDC_JWKS_URI'),
      algorithm: algorithm as OidcConfig['algorithm'],
      clientId: required('OIDC_CLIENT_ID'),
      authorizationEndpoint: url('OIDC_AUTHORIZATION_ENDPOINT'),
      tokenEndpoint: url('OIDC_TOKEN_ENDPOINT'),
      redirectUri,
      scopes,
      maxAgeSeconds: integer('OIDC_MAX_TOKEN_AGE_SECONDS', 3600, 60, 86400),
    }
    if (oidc.issuer === issuer) fail('OIDC_ISSUER')
  }
  const config = {
    destinationId,
    issuer,
    audience: required('API_JWT_AUDIENCE'),
    keyId,
    privateKeyFile: file('API_SIGNING_PRIVATE_KEY_FILE'),
    encryptionKeyFile: file('API_AUTH_ENCRYPTION_KEY_FILE'),
    accessSeconds: integer('API_ACCESS_SECONDS', 600, 60, 600),
    idleDays: integer('API_REFRESH_IDLE_DAYS', 30, 1, 30),
    absoluteDays: integer('API_REFRESH_ABSOLUTE_DAYS', 90, 1, 90),
    oidc,
  }
  if (config.idleDays > config.absoluteDays) fail('API_REFRESH_IDLE_DAYS')
  return config
}
