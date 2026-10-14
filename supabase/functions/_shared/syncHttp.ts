import {
  AuthFailure,
  principalFromVerifiedUser,
  verifyDeviceProof,
  type Rpc,
} from './tabletAuth.ts'
import {
  object,
  parseStrictJson,
  SyncFailure,
  validateSync,
  type JsonObject,
  type SyncEndpoint,
} from './syncProtocol.ts'

const errors: Record<string, [number, string, boolean]> = {
  AUTH_REQUIRED: [401, 'auth', false],
  ACCESS_REVOKED: [403, 'auth', false],
  SCOPE_DENIED: [403, 'auth', false],
  INSTALLATION_RETIRED: [403, 'auth', false],
  HEAD_MOVED: [409, 'recovery', false],
  MISSING_PREDECESSOR: [409, 'recovery', false],
  DEPENDENCY_MISSING: [409, 'recovery', false],
  EVENT_CONTENT_CONFLICT: [409, 'permanent', false],
  SEQUENCE_FORK: [409, 'permanent', false],
  DUPLICATE_ORDER_OTHER_CHAIN: [409, 'permanent', false],
  BATCH_TOO_LARGE: [413, 'recovery', false],
  EVENT_TOO_LARGE: [422, 'permanent', false],
  INVALID_ENVELOPE: [400, 'permanent', false],
  INVALID_HASH: [422, 'permanent', false],
  INVALID_FINGERPRINT: [422, 'permanent', false],
  INVALID_PAYLOAD: [422, 'permanent', false],
  BUSINESS_INCONSISTENCY: [422, 'permanent', false],
  CANONICALIZATION_UNSUPPORTED: [422, 'permanent', false],
  PROTOCOL_UNSUPPORTED: [426, 'recovery', false],
  LEDGER_SCHEMA_UNSUPPORTED: [422, 'recovery', false],
  TRANSACTION_RETRY: [503, 'temporary', true],
  SERVER_UNAVAILABLE: [503, 'temporary', true],
  INTERNAL_ERROR: [500, 'temporary', true],
  RATE_LIMITED: [429, 'temporary', true],
  METHOD_NOT_ALLOWED: [405, 'permanent', false],
  HTTPS_REQUIRED: [400, 'permanent', false],
}
export type SyncDependencies = {
  authenticate: (jwt: string) => Promise<{ id: string; sessionId: string }>
  proofRpc: Rpc
  transact: (
    subject: string,
    sessionId: string,
    endpoint: SyncEndpoint,
    raw: string,
    nonce: string,
  ) => Promise<JsonObject>
}

export async function handleSync(
  request: Request,
  endpoint: SyncEndpoint,
  deps: SyncDependencies,
): Promise<Response> {
  let requestId: unknown = null
  const reply = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '2' } : {}) },
    })
  try {
    if (request.method !== 'POST') throw new SyncFailure('METHOD_NOT_ALLOWED')
    // Gateway terminates TLS; its forwarded protocol must be HTTPS too. Loopback is local testing only.
    const url = new URL(request.url)
    if (
      url.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', 'kong'].includes(url.hostname) &&
      request.headers.get('x-forwarded-proto') !== 'https'
    )
      throw new SyncFailure('HTTPS_REQUIRED')
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') ?? '') ||
      request.headers.has('content-encoding')
    )
      throw new SyncFailure('INVALID_ENVELOPE')
    const jwt = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!jwt) throw new SyncFailure('AUTH_REQUIRED')
    const principal = await deps.authenticate(jwt)
    const reader = request.body?.getReader()
    if (!reader) throw new SyncFailure('INVALID_ENVELOPE')
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let raw = '',
      length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1048576) {
        await reader.cancel()
        throw new SyncFailure('BATCH_TOO_LARGE')
      }
      try {
        raw += decoder.decode(value, { stream: true })
      } catch {
        throw new SyncFailure('INVALID_PAYLOAD')
      }
    }
    try {
      raw += decoder.decode()
    } catch {
      throw new SyncFailure('INVALID_PAYLOAD')
    }
    const parsed = object(parseStrictJson(raw))
    if (typeof parsed.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.requestId))
      requestId = parsed.requestId
    validateSync(raw, endpoint)
    const nonce = request.headers.get('x-samhain-nonce')
    const signature = request.headers.get('x-samhain-signature')
    if (!nonce || !signature) throw new SyncFailure('ACCESS_REVOKED')
    await verifyDeviceProof(
      principal.id,
      endpoint,
      { payload: raw, nonce, signature },
      deps.proofRpc,
    )
    // PostgREST responds only after transaction commit (including deferred constraints).
    return reply(await deps.transact(principal.id, principal.sessionId, endpoint, raw, nonce))
  } catch (error) {
    // Operational diagnostics deliberately contain no payload, token or signature.
    if (error instanceof AuthFailure) console.error('sync proof rejected:', error.code)
    let code = error instanceof SyncFailure ? error.code : 'INTERNAL_ERROR'
    if (error instanceof AuthFailure)
      code =
        error.status === 401
          ? 'AUTH_REQUIRED'
          : error.code === 'RATE_LIMITED'
            ? 'RATE_LIMITED'
            : 'ACCESS_REVOKED'
    const [status, category, retryable] = errors[code] ?? errors.INTERNAL_ERROR
    const diagnostic = error instanceof SyncFailure ? error.diagnostic : {}
    return reply(
      {
        protocolVersion: 1,
        requestId,
        error: { code: errors[code] ? code : 'INTERNAL_ERROR', category, retryable, ...diagnostic },
      },
      status,
    )
  }
}

export function syncDependencies(origin: string, serverKey: string): SyncDependencies {
  async function rpc(name: string, args: JsonObject): Promise<JsonObject> {
    let response: Response
    try {
      response = await fetch(`${origin}/rest/v1/rpc/${name}`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          apikey: serverKey,
          Authorization: `Bearer ${serverKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      })
    } catch {
      throw new SyncFailure('SERVER_UNAVAILABLE')
    }
    if (!response.ok) {
      let data: JsonObject
      try {
        data = object(await response.json())
      } catch {
        throw new SyncFailure('SERVER_UNAVAILABLE')
      }
      console.error(
        'sync RPC rejected:',
        data.code,
        typeof data.message === 'string' &&
          (errors[data.message] || data.message.startsWith('permission denied'))
          ? data.message
          : 'internal',
      )
      if (['40001', '40P01', '55P03', '57014'].includes(String(data.code)))
        throw new SyncFailure('TRANSACTION_RETRY')
      const code =
        typeof data.message === 'string' && errors[data.message]
          ? data.message
          : data.code === '42501' &&
              !(typeof data.message === 'string' && data.message.startsWith('permission denied'))
            ? 'ACCESS_REVOKED'
            : 'INTERNAL_ERROR'
      // Only explicitly whitelisted diagnostics may leave the server.
      const diagnostic: JsonObject = {}
      if (typeof data.detail === 'string' || typeof data.details === 'string') {
        try {
          const details = object(JSON.parse(String(data.detail ?? data.details)))
          if (typeof details.eventId === 'string') diagnostic.eventId = details.eventId
          if (details.expectedHead) diagnostic.expectedHead = details.expectedHead
        } catch {
          /* SQL details are not generally safe to disclose. */
        }
      }
      throw new SyncFailure(code, diagnostic)
    }
    return object(await response.json())
  }
  return {
    proofRpc: (subject, action, body, nonce) =>
      rpc('tablet_auth_v1', { subject, action, body, proof_nonce: nonce ?? null }),
    transact: (subject, sessionId, endpoint, raw, nonce) =>
      rpc(endpoint.replaceAll('-', '_'), {
        subject,
        session_id: sessionId,
        raw_body: raw,
        proof_nonce: nonce,
      }),
    authenticate: async (jwt) => {
      let response: Response
      try {
        response = await fetch(`${origin}/auth/v1/user`, {
          signal: AbortSignal.timeout(30_000),
          headers: { apikey: serverKey, Authorization: `Bearer ${jwt}` },
        })
      } catch {
        throw new SyncFailure('SERVER_UNAVAILABLE')
      }
      if (response.status >= 500 || response.status === 429)
        throw new SyncFailure(response.status === 429 ? 'RATE_LIMITED' : 'SERVER_UNAVAILABLE')
      if (!response.ok) throw new SyncFailure('AUTH_REQUIRED')
      const user = object(await response.json())
      const principal = principalFromVerifiedUser(user, jwt)
      // Claims are inspected only AFTER Auth has verified this exact token; SQL checks the live session.
      const encoded = jwt.split('.')[1]?.replaceAll('-', '+').replaceAll('_', '/')
      let claims: JsonObject
      try {
        claims = object(JSON.parse(atob(encoded ?? '')))
      } catch {
        throw new SyncFailure('AUTH_REQUIRED')
      }
      if (typeof claims.session_id !== 'string') throw new SyncFailure('AUTH_REQUIRED')
      return { id: principal.id, sessionId: claims.session_id }
    },
  }
}
