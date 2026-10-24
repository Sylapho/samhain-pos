import type { Head, ChainScope } from '../persistence/model.ts'
import type { LedgerProof, LegacyProof } from '../persistence/proofs.ts'
import { canonical, fingerprint, sha256 } from '../persistence/proofs.ts'
import { stable } from '../persistence/migrations.ts'
import { parseStrictJson } from '../json.ts'
import { ApiError } from '../errors.ts'
import { fail, object, keys, text, integer, array } from './validation.ts'

export type Endpoint = 'ingest' | 'legacy' | 'prefix'
export type Tuple = {
  sequence: number
  eventId: string
  hash: string
  transportFingerprint: string
}
export type Context = ChainScope & {
  protocolVersion: 1
  requestId: string
  installationId: string
  enrollmentGeneration: number
}
export type Request =
  | (Context & { expectedHead: Head; events: LedgerProof[] })
  | (Context & { events: LegacyProof[] })
  | (Context & { events: Tuple[] })
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function validatedRequestId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('requestId' in body)) return null
  return typeof body.requestId === 'string' && uuidPattern.test(body.requestId)
    ? body.requestId
    : null
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('INVALID_ENVELOPE', 400)
  return value
}
export function validateRequest(
  body: unknown,
  endpoint: 'ingest',
): Context & { expectedHead: Head; events: LedgerProof[] }
export function validateRequest(
  body: unknown,
  endpoint: 'legacy',
): Context & { events: LegacyProof[] }
export function validateRequest(body: unknown, endpoint: 'prefix'): Context & { events: Tuple[] }
export function validateRequest(body: unknown, endpoint: Endpoint): Request
export function validateRequest(body: unknown, endpoint: Endpoint): Request {
  let context: Context
  let events: unknown[]
  let expectedHead: Head = { sequence: 0, hash: null }
  try {
    const v = object(body)
    if (v.protocolVersion !== 1) fail('PROTOCOL_UNSUPPORTED', 426)
    keys(v, [
      'protocolVersion',
      'requestId',
      'organizationId',
      'festivalId',
      'chainId',
      'installationId',
      'enrollmentGeneration',
      'events',
      ...(endpoint === 'ingest' ? ['expectedHead'] : []),
    ])
    for (const key of ['requestId', 'organizationId', 'festivalId', 'chainId', 'installationId'])
      if (!uuidPattern.test(text(v[key]))) fail('INVALID_ENVELOPE', 400)
    context = {
      protocolVersion: 1,
      requestId: text(v.requestId),
      organizationId: text(v.organizationId),
      festivalId: text(v.festivalId),
      chainId: text(v.chainId),
      installationId: text(v.installationId),
      enrollmentGeneration: integer(v.enrollmentGeneration, 1),
    }
    if (endpoint === 'ingest') {
      const head = object(v.expectedHead)
      keys(head, ['sequence', 'hash'])
      expectedHead = {
        sequence: integer(head.sequence, 0),
        hash: head.hash === null ? null : hash(head.hash),
      }
      if ((expectedHead.sequence === 0) !== (expectedHead.hash === null))
        fail('INVALID_ENVELOPE', 400)
    }
    events = array(v.events)
    if (!events.length && endpoint !== 'prefix') fail('INVALID_ENVELOPE', 400)
    if (events.length > 100) fail('BATCH_TOO_LARGE', 413)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'INVALID_PAYLOAD') fail('INVALID_ENVELOPE', 400)
    throw error
  }
  const ids = new Set<string>()
  let previousSequence = 0
  const parsed = events.map((value) => {
    const v = object(value)
    keys(
      v,
      endpoint === 'prefix'
        ? ['sequence', 'eventId', 'hash', 'transportFingerprint']
        : [
            'eventId',
            'eventType',
            'ledgerSchemaVersion',
            'sourceTerminalId',
            'sequence',
            'hash',
            'previousHash',
            'ledgerCanonicalization',
            'payloadCanonical',
            'transportFingerprint',
          ],
    )
    const eventId = text(v.eventId, true)
    if (ids.has(eventId)) fail('INVALID_ENVELOPE', 400)
    ids.add(eventId)
    const transportFingerprint = hash(v.transportFingerprint)
    if (endpoint !== 'legacy') {
      const sequence = integer(v.sequence, 1)
      if (sequence <= previousSequence) fail('INVALID_ENVELOPE', 400)
      previousSequence = sequence
    }
    if (endpoint === 'prefix')
      return { eventId, transportFingerprint, sequence: integer(v.sequence, 1), hash: hash(v.hash) }
    const sourceTerminalId = text(v.sourceTerminalId, true)
    if (typeof v.payloadCanonical !== 'string') fail()
    const payloadCanonical = v.payloadCanonical
    if (Buffer.byteLength(payloadCanonical) > 262144) fail('EVENT_TOO_LARGE')
    const payload = object(parseStrictJson(payloadCanonical))
    if (endpoint === 'legacy') {
      if (
        v.eventType !== 'legacy_order' ||
        ['ledgerSchemaVersion', 'sequence', 'hash', 'previousHash', 'ledgerCanonicalization'].some(
          (key) => v[key] !== null,
        )
      )
        fail('INVALID_ENVELOPE', 400)
      const proof: LegacyProof = {
        eventId,
        sourceTerminalId,
        payloadCanonical,
        transportFingerprint,
      }
      if (payload.id !== eventId || stable(payload) !== payloadCanonical) fail()
      if (fingerprint(context, proof, true) !== transportFingerprint) fail('INVALID_FINGERPRINT')
      return proof
    }
    if (v.eventType !== 'ledger') fail('INVALID_ENVELOPE', 400)
    if (v.ledgerSchemaVersion !== 1) fail('LEDGER_SCHEMA_UNSUPPORTED')
    if (
      v.ledgerCanonicalization !== 'ts-ledger-v1' &&
      v.ledgerCanonicalization !== 'android-ledger-v1'
    )
      fail('CANONICALIZATION_UNSUPPORTED')
    const proof: LedgerProof = {
      eventId,
      sourceTerminalId,
      payloadCanonical,
      transportFingerprint,
      sequence: integer(v.sequence, 1),
      hash: hash(v.hash),
      previousHash: v.previousHash === null ? null : hash(v.previousHash),
      ledgerCanonicalization: v.ledgerCanonicalization,
    }
    if (payload.schemaVersion !== 1) fail('LEDGER_SCHEMA_UNSUPPORTED')
    if (
      payload.id !== eventId ||
      payload.sequence !== proof.sequence ||
      payload.hash !== proof.hash ||
      payload.previousHash !== proof.previousHash ||
      object(object(payload.source).terminal).terminalId !== sourceTerminalId ||
      canonical(payload, proof.ledgerCanonicalization) !== payloadCanonical
    )
      fail()
    const { hash: ignored, ...unsigned } = payload
    void ignored
    if (sha256(canonical(unsigned, proof.ledgerCanonicalization)) !== proof.hash)
      fail('INVALID_HASH')
    if ((proof.sequence === 1) !== (proof.previousHash === null)) fail('INVALID_HASH')
    if (fingerprint(context, proof) !== transportFingerprint) fail('INVALID_FINGERPRINT')
    return proof
  })
  // Every branch above constructs its own validated wire projection.
  if (endpoint === 'ingest') return { ...context, expectedHead, events: parsed as LedgerProof[] }
  return { ...context, events: parsed } as Request
}
