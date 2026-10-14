import { canonicalJson, sha256Hex } from '../../../src/utils/integrity.ts'

export type SyncEndpoint = 'ledger-ingest-v1' | 'legacy-import-v1' | 'ledger-prefix-v1'
export type JsonObject = Record<string, unknown>
export class SyncFailure extends Error {
  constructor(
    readonly code: string,
    readonly diagnostic: JsonObject = {},
  ) {
    super(code)
  }
}
export const hashPattern = /^[0-9a-f]{64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()

// JSON.parse alone discards duplicate keys and rounds unsafe numbers. Inspect tokens first.
export function parseStrictJson(raw: string): unknown {
  let at = 0
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(raw[at] ?? 'x')) at++
  }
  const invalid = (): never => {
    throw new SyncFailure('INVALID_PAYLOAD')
  }
  function string(): string {
    const start = at++
    while (at < raw.length) {
      const c = raw[at++]
      if (c === '\\') {
        at++
        continue
      }
      if (c !== '"') continue
      let value: string
      try {
        value = JSON.parse(raw.slice(start, at))
      } catch {
        return invalid()
      }
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i)
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = value.charCodeAt(++i)
          if (!(low >= 0xdc00 && low <= 0xdfff)) invalid()
        } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid()
      }
      return value
    }
    return invalid()
  }
  function value(depth: number): void {
    if (depth > 64) invalid()
    whitespace()
    const c = raw[at]
    if (c === '"') {
      string()
      return
    }
    if (c === '{' || c === '[') {
      at++
      whitespace()
      const close = c === '{' ? '}' : ']'
      if (raw[at] === close) {
        at++
        return
      }
      const keys = new Set<string>()
      while (true) {
        if (c === '{') {
          if (raw[at] !== '"') invalid()
          const key = string()
          if (keys.has(key)) invalid()
          keys.add(key)
          whitespace()
          if (raw[at++] !== ':') invalid()
        }
        value(depth + 1)
        whitespace()
        if (raw[at] === close) {
          at++
          return
        }
        if (raw[at++] !== ',') invalid()
        whitespace()
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      raw.slice(at),
    )?.[0]
    if (!token) return invalid()
    if (/^-?\d/.test(token)) {
      if (!Number.isSafeInteger(Number(token))) invalid()
      // A fractional suffix can round to an integer near MAX_SAFE_INTEGER in JS.
      // Inspect decimal digits too; SQL independently uses exact numeric arithmetic.
      const [mantissa, exponent = '0'] = token.replace(/^-/, '').split(/[eE]/)
      const [whole, fraction = ''] = mantissa.split('.')
      const digits = (whole + fraction).replace(/^0+/, '')
      const shift = Number(exponent) - fraction.length
      if (digits && shift < 0 && (shift < -digits.length || /[1-9]/.test(digits.slice(shift))))
        invalid()
    }
    at += token.length
  }
  value(0)
  whitespace()
  if (at !== raw.length) invalid()
  try {
    return JSON.parse(raw)
  } catch {
    return invalid()
  }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyncFailure('INVALID_ENVELOPE')
  return value as JsonObject
}
function keys(value: JsonObject, required: string[], optional: string[] = []): void {
  if (
    required.some((k) => !(k in value)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new SyncFailure('INVALID_ENVELOPE')
}
function opaque(value: unknown): void {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).length > 512)
    throw new SyncFailure('INVALID_ENVELOPE')
}
function hash(value: unknown, nullable = false): void {
  if (!(nullable && value === null) && !(typeof value === 'string' && hashPattern.test(value)))
    throw new SyncFailure('INVALID_ENVELOPE')
}
function integer(value: unknown, minimum: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new SyncFailure('INVALID_ENVELOPE')
}

// Android's platform JSONObject.quote uses JSONStringer: every slash is escaped.
// All numeric fields in schema 1 are safe integers, so BigDecimal's plain notation equals JS.
export function ledgerCanonical(value: unknown, profile: string): string {
  const ts = canonicalJson(value)
  if (profile === 'ts-ledger-v1') return ts
  if (profile === 'android-ledger-v1') return ts.replaceAll('/', '\\/')
  throw new SyncFailure('CANONICALIZATION_UNSUPPORTED')
}

export function fingerprint(context: JsonObject, event: JsonObject): string {
  const { transportFingerprint: _ignored, ...fields } = event
  void _ignored
  return sha256Hex(
    canonicalJson({
      protocolVersion: 1,
      organizationId: context.organizationId,
      festivalId: context.festivalId,
      chainId: context.chainId,
      ...fields,
    }),
  )
}

export function validateSync(raw: string, endpoint: SyncEndpoint): JsonObject {
  const body = object(parseStrictJson(raw))
  if (body.protocolVersion !== 1) throw new SyncFailure('PROTOCOL_UNSUPPORTED')
  keys(body, [
    'protocolVersion',
    'requestId',
    'organizationId',
    'festivalId',
    'chainId',
    'installationId',
    'enrollmentGeneration',
    ...(endpoint === 'ledger-ingest-v1' ? ['expectedHead'] : []),
    'events',
  ])
  for (const k of ['requestId', 'organizationId', 'festivalId', 'chainId', 'installationId'])
    if (typeof body[k] !== 'string' || !uuidPattern.test(body[k]))
      throw new SyncFailure('INVALID_ENVELOPE')
  integer(body.enrollmentGeneration, 1)
  if (endpoint === 'ledger-ingest-v1') {
    const head = object(body.expectedHead)
    keys(head, ['sequence', 'hash'])
    integer(head.sequence, 0)
    hash(head.hash, true)
    if ((head.sequence === 0) !== (head.hash === null)) throw new SyncFailure('INVALID_ENVELOPE')
  }
  if (!Array.isArray(body.events) || (body.events.length < 1 && endpoint !== 'ledger-prefix-v1'))
    throw new SyncFailure('INVALID_ENVELOPE')
  if (body.events.length > 100) throw new SyncFailure('BATCH_TOO_LARGE')
  let lastSequence = 0
  const ids = new Set<string>()
  for (const candidate of body.events) {
    const event = object(candidate)
    if (endpoint === 'ledger-prefix-v1') {
      keys(event, ['sequence', 'eventId', 'hash', 'transportFingerprint'])
      integer(event.sequence, 1)
      opaque(event.eventId)
      hash(event.hash)
      hash(event.transportFingerprint)
    } else {
      keys(event, [
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
      ])
      opaque(event.eventId)
      opaque(event.sourceTerminalId)
      hash(event.transportFingerprint)
      if (typeof event.payloadCanonical !== 'string') throw new SyncFailure('INVALID_PAYLOAD')
      if (encoder.encode(event.payloadCanonical).length > 262144)
        throw new SyncFailure('EVENT_TOO_LARGE')
      const payload = object(parseStrictJson(event.payloadCanonical))
      if (endpoint === 'legacy-import-v1') {
        if (
          event.eventType !== 'legacy_order' ||
          [
            'ledgerSchemaVersion',
            'sequence',
            'hash',
            'previousHash',
            'ledgerCanonicalization',
          ].some((k) => event[k] !== null)
        )
          throw new SyncFailure('INVALID_ENVELOPE')
        if (payload.id !== event.eventId || event.payloadCanonical !== canonicalJson(payload))
          throw new SyncFailure('INVALID_PAYLOAD')
      } else {
        if (event.eventType !== 'ledger') throw new SyncFailure('INVALID_ENVELOPE')
        if (event.ledgerSchemaVersion !== 1) throw new SyncFailure('LEDGER_SCHEMA_UNSUPPORTED')
        integer(event.sequence, 1)
        hash(event.hash)
        hash(event.previousHash, true)
        if (typeof event.ledgerCanonicalization !== 'string')
          throw new SyncFailure('CANONICALIZATION_UNSUPPORTED')
        if (event.payloadCanonical !== ledgerCanonical(payload, event.ledgerCanonicalization))
          throw new SyncFailure('INVALID_PAYLOAD')
        if (
          payload.id !== event.eventId ||
          payload.schemaVersion !== 1 ||
          payload.sequence !== event.sequence ||
          payload.hash !== event.hash ||
          payload.previousHash !== event.previousHash ||
          object(object(payload.source).terminal).terminalId !== event.sourceTerminalId
        )
          throw new SyncFailure('INVALID_PAYLOAD')
        const { hash: _hash, ...withoutHash } = payload
        void _hash
        if (sha256Hex(ledgerCanonical(withoutHash, event.ledgerCanonicalization)) !== event.hash)
          throw new SyncFailure('INVALID_HASH')
      }
      if (fingerprint(body, event) !== event.transportFingerprint)
        throw new SyncFailure('INVALID_FINGERPRINT')
    }
    const id = event.eventId as string
    if (ids.has(id)) throw new SyncFailure('INVALID_ENVELOPE')
    ids.add(id)
    if (endpoint !== 'legacy-import-v1') {
      const sequence = event.sequence as number
      if (sequence <= lastSequence) throw new SyncFailure('INVALID_ENVELOPE')
      lastSequence = sequence
    }
  }
  return body
}
