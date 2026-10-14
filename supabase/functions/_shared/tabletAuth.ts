export type Rpc = (
  subject: string,
  action: string,
  body: Record<string, unknown>,
  nonce?: string,
) => Promise<Record<string, unknown>>

export class AuthFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 403,
  ) {
    super(code)
  }
}

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
}

export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}

// Invoke only after Auth /user has verified the exact JWT and live session.
export function principalFromVerifiedUser(user: Record<string, unknown>, jwt: string) {
  if (typeof user.id !== 'string') throw new AuthFailure('AUTH_REQUIRED', 401)
  const verifiedMfa =
    Array.isArray(user.factors) &&
    user.factors.some(
      (factor: unknown) =>
        typeof factor === 'object' &&
        factor !== null &&
        'status' in factor &&
        factor.status === 'verified',
    )
  if (verifiedMfa) {
    const encoded = jwt.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    if (!encoded) throw new AuthFailure('MFA_REQUIRED')
    const claims: Record<string, unknown> = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')),
    )
    if (claims.aal !== 'aal2') throw new AuthFailure('MFA_REQUIRED')
  }
  return { id: user.id, anonymous: user.is_anonymous === true }
}

// #36 must consume this verified nonce INSIDE its financial transaction.
export async function verifyDeviceProof(
  subject: string,
  action: string,
  envelope: Record<string, unknown>,
  rpc: Rpc,
): Promise<{ body: Record<string, unknown>; nonce: string }> {
  if (
    typeof envelope.payload !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.signature !== 'string'
  )
    throw new AuthFailure('PROOF_REQUIRED')
  const body: Record<string, unknown> = JSON.parse(envelope.payload)
  if (typeof body.installationId !== 'string') throw new AuthFailure('INSTALLATION_DENIED')
  const challenge = await rpc(subject, 'proof', {
    installationId: body.installationId,
    nonce: envelope.nonce,
  })
  if (typeof challenge.publicKey !== 'string') throw new AuthFailure('PROOF_REQUIRED')
  const key = await crypto.subtle.importKey(
    'spki',
    bytes(challenge.publicKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  if ((key.algorithm as RsaKeyAlgorithm).modulusLength < 2048)
    throw new AuthFailure('PROOF_INVALID')
  const message = `samhain-auth/1\n${body.installationId}\n${action}\n${envelope.nonce}\n${await digest(envelope.payload)}`
  if (
    !(await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      bytes(envelope.signature),
      new TextEncoder().encode(message),
    ))
  )
    throw new AuthFailure('PROOF_INVALID')
  return { body, nonce: envelope.nonce }
}

export async function handleTabletAuth(
  request: Request,
  deps: {
    authenticate: (jwt: string) => Promise<{ id: string; anonymous: boolean }>
    rpc: Rpc
  },
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
  try {
    if (request.method !== 'POST') return reply({ code: 'METHOD_NOT_ALLOWED' }, 405)
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return reply({ code: 'INVALID_REQUEST' }, 400)
    const jwt = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!jwt) throw new AuthFailure('AUTH_REQUIRED', 401)
    const principal = await deps.authenticate(jwt)
    const reader = request.body?.getReader()
    if (!reader) return reply({ code: 'INVALID_REQUEST' }, 400)
    const decoder = new TextDecoder()
    let raw = ''
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1048576) {
        await reader.cancel()
        return reply({ code: 'REQUEST_TOO_LARGE' }, 413)
      }
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
    const envelope: Record<string, unknown> = JSON.parse(raw)
    const action = envelope.action
    if (
      typeof action !== 'string' ||
      !['request', 'challenge', 'activate', 'status', 'approve', 'revoke', 'authorize'].includes(
        action,
      )
    )
      return reply({ code: 'ACTION_UNKNOWN' }, 400)
    if (action === 'approve' || action === 'revoke') {
      if (principal.anonymous) throw new AuthFailure('MANAGER_REQUIRED')
      const body = envelope.body as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply({ code: 'INVALID_REQUEST' }, 400)
      if (action === 'approve') {
        const code = base64(crypto.getRandomValues(new Uint8Array(32)))
        const result = await deps.rpc(principal.id, action, {
          ...body,
          invitationHash: await digest(code),
        })
        return reply({ ...result, invitationCode: code })
      }
      return reply(await deps.rpc(principal.id, action, body))
    }
    if (action === 'request' || action === 'challenge') {
      const body = envelope.body as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply({ code: 'INVALID_REQUEST' }, 400)
      const result = await deps.rpc(principal.id, action, body)
      if (action === 'challenge') return reply({ nonce: result.nonce })
      return reply(result)
    }
    const { body, nonce } = await verifyDeviceProof(principal.id, action, envelope, deps.rpc)
    if (action === 'activate') {
      if (typeof body.invitationCode !== 'string')
        return reply({ code: 'INVITATION_REQUIRED' }, 400)
      const { invitationCode, ...rest } = body
      return reply(
        await deps.rpc(
          principal.id,
          action,
          { ...rest, invitationHash: await digest(invitationCode) },
          nonce,
        ),
      )
    }
    return reply(await deps.rpc(principal.id, action, body, nonce))
  } catch (error) {
    if (error instanceof AuthFailure) return reply({ code: error.code }, error.status)
    return reply({ code: 'AUTH_OPERATION_FAILED' }, 400)
  }
}
