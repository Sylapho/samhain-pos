import {
  validateCatalogContent,
  MAX_CATALOG_BYTES,
} from '../../../src/services/catalogDistribution.ts'
import { AuthFailure, verifyDeviceProof, type Rpc } from './tabletAuth.ts'
import { syncDependencies } from './syncHttp.ts'
import { SyncFailure, parseStrictJson } from './syncProtocol.ts'

type Dependencies = {
  authenticate(jwt: string): Promise<{ id: string; sessionId: string; anonymous?: boolean }>
  proofRpc: Rpc
  transact(
    subject: string,
    sessionId: string,
    body: Record<string, unknown>,
    nonce?: string,
  ): Promise<Record<string, unknown>>
}

export async function handleCatalog(request: Request, deps: Dependencies): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
  try {
    const url = new URL(request.url)
    if (
      (url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', 'kong'].includes(url.hostname) &&
        request.headers.get('x-forwarded-proto') !== 'https') ||
      request.method !== 'POST' ||
      !request.headers.get('content-type')?.startsWith('application/json') ||
      request.headers.has('content-encoding')
    )
      return reply({ code: 'INVALID_REQUEST' }, 400)
    const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token) throw new AuthFailure('AUTH_REQUIRED', 401)
    const principal = await deps.authenticate(token)
    const reader = request.body?.getReader()
    if (!reader) return reply({ code: 'INVALID_REQUEST' }, 400)
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_CATALOG_BYTES) {
        await reader.cancel()
        return reply({ code: 'CATALOG_TOO_LARGE' }, 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const body = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >
    if (body.action === 'read') {
      const nonce = request.headers.get('x-samhain-nonce')
      const signature = request.headers.get('x-samhain-signature')
      const proof = await verifyDeviceProof(
        principal.id,
        'catalog-v1',
        { payload: new TextDecoder().decode(bytes), nonce, signature },
        deps.proofRpc,
      )
      return reply(await deps.transact(principal.id, principal.sessionId, body, proof.nonce))
    }
    if (body.action !== 'publish' || principal.anonymous) throw new AuthFailure('PUBLISH_DENIED')
    const content = validateCatalogContent(body)
    return reply(await deps.transact(principal.id, principal.sessionId, { ...body, ...content }))
  } catch (error) {
    if (error instanceof AuthFailure) return reply({ code: error.code }, error.status)
    if (error instanceof SyncFailure)
      return reply(
        { code: 'CATALOG_AUTH_OR_NETWORK_ERROR' },
        error.code === 'AUTH_REQUIRED' ? 401 : 503,
      )
    const code = error instanceof Error ? error.message : ''
    if (code === 'CATALOG_HEAD_MOVED') return reply({ code }, 409)
    if (code === 'PUBLISH_DENIED') return reply({ code }, 403)
    return reply({ code: 'CATALOG_OPERATION_FAILED' }, 400)
  }
}

export function catalogDependencies(origin: string, serverKey: string): Dependencies {
  const auth = syncDependencies(origin, serverKey)
  return {
    authenticate: auth.authenticate,
    proofRpc: auth.proofRpc,
    transact: async (subject, sessionId, body, nonce) => {
      const response = await fetch(`${origin}/rest/v1/rpc/catalog_v1`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          apikey: serverKey,
          Authorization: `Bearer ${serverKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subject, session_id: sessionId, body, proof_nonce: nonce ?? null }),
      })
      if (!response.ok) {
        const error = await response.json()
        if (error.message === 'CATALOG_HEAD_MOVED') throw new Error('CATALOG_HEAD_MOVED')
        if (error.code === '42501') throw new AuthFailure('PUBLISH_DENIED')
        throw new Error('CATALOG_OPERATION_FAILED')
      }
      return await response.json()
    },
  }
}
