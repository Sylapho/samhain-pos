// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../../../src/utils/integrity'
import {
  fingerprint,
  ledgerCanonical,
  parseStrictJson,
  validateSync,
  type JsonObject,
} from './syncProtocol'
import { handleSync, type SyncDependencies } from './syncHttp'
import { AuthFailure } from './tabletAuth'

const doc = readFileSync(
  new URL('../../../docs/architecture-supabase-offline-first.md', import.meta.url),
  'utf8',
)
const fixture = JSON.parse(
  doc.split('<!-- sync-request-example -->')[1].split('```json')[1].split('```')[0],
) as JsonObject
const original = (fixture.events as JsonObject[])[0]
function request(raw: string, headers: Record<string, string> = {}) {
  return new Request('https://test.invalid/functions/v1/ledger-ingest-v1', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer verified-test-only',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: raw,
  })
}
const deps = (): SyncDependencies => ({
  authenticate: async () => ({ id: 'verified-subject', sessionId: 'live-session' }),
  proofRpc: vi.fn(),
  transact: vi.fn(),
})

describe('samhain-sync/1 transport and canonicalization', () => {
  it('reproduces the published hash and fingerprint vector', () => {
    expect(validateSync(JSON.stringify(fixture), 'ledger-ingest-v1')).toEqual(fixture)
    expect(fingerprint(fixture, original)).toBe(original.transportFingerprint)
  })
  it('matches frozen TS and native Android hash vectors', () => {
    const value = { previousHash: null, n: 9007199254740991, id: 'é😀</x>/' }
    expect(sha256Hex(ledgerCanonical(value, 'ts-ledger-v1'))).toBe(
      'c81007f4eea9d748ac5a6f0341524d18d9e643dab12f0951b1ffdd379534fc70',
    )
    expect(sha256Hex(ledgerCanonical(value, 'android-ledger-v1'))).toBe(
      '97dedfa5fa794d60f77027e737c065e809e9fb68466f7b8e3db14207c53d784b',
    )
  })
  it.each([
    '{"x":1,"x":2}',
    '{"a":{"x":1,"\\u0078":2}}',
    '[9007199254740992]',
    '[9007199254740991.1]',
    '[1.0000000000000000001]',
    '"\\ud800"',
    '"\\udfff"',
    '{"x":1.5}',
    '[NaN]',
    '[1,]',
  ])('rejects ambiguous JSON %s', (raw) => {
    expect(() => parseStrictJson(raw)).toThrow('INVALID_PAYLOAD')
  })
  it('rejects excessive nesting without overflowing the stack', () => {
    expect(() => parseStrictJson('['.repeat(65) + '0' + ']'.repeat(65))).toThrow('INVALID_PAYLOAD')
  })
  it('preserves null, absence, Unicode, UTF-16 ordering, escaping and safe integer limits', () => {
    const value = {
      '\ue000': 1,
      '😀': 2,
      text: 'é😀</x>/\n\b\t\r\f"\\\u2028\u2029\u0001',
      n: 9007199254740991,
      min: -9007199254740991,
      zero: -0,
      null: null,
    }
    const ts = canonicalJson(value)
    expect(ts.indexOf('😀')).toBeLessThan(ts.indexOf('\ue000'))
    expect(ledgerCanonical(value, 'android-ledger-v1')).toBe(ts.replaceAll('/', '\\/'))
    expect(parseStrictJson(ts)).toEqual({ ...value, zero: 0 })
    expect(ts).toContain('"null":null')
    expect(ts).not.toContain('absent')
  })
  it('validates Android payload with the original profile and transport fingerprint', () => {
    const b = structuredClone(fixture)
    const e = (b.events as JsonObject[])[0]
    const payload = JSON.parse(e.payloadCanonical as string)
    payload.source.terminal.displayName = 'Caisse / é😀\u2028'
    const { hash: _hash, ...content } = payload
    void _hash
    e.ledgerCanonicalization = 'android-ledger-v1'
    e.hash = payload.hash = sha256Hex(ledgerCanonical(content, 'android-ledger-v1'))
    e.payloadCanonical = ledgerCanonical(payload, 'android-ledger-v1')
    e.transportFingerprint = fingerprint(b, e)
    expect(validateSync(JSON.stringify(b), 'ledger-ingest-v1')).toEqual(b)
  })
  it.each([
    [
      'PROTOCOL_UNSUPPORTED',
      (b: JsonObject) => {
        b.protocolVersion = 2
      },
    ],
    [
      'INVALID_ENVELOPE',
      (b: JsonObject) => {
        b.extra = true
      },
    ],
    [
      'BATCH_TOO_LARGE',
      (b: JsonObject) => {
        b.events = Array(101).fill(original)
      },
    ],
    [
      'LEDGER_SCHEMA_UNSUPPORTED',
      (b: JsonObject) => {
        ;(b.events as JsonObject[])[0].ledgerSchemaVersion = 2
      },
    ],
    [
      'INVALID_HASH',
      (b: JsonObject) => {
        const e = (b.events as JsonObject[])[0]
        const p = JSON.parse(e.payloadCanonical as string)
        p.session.openingFloatCents = 1
        e.payloadCanonical = canonicalJson(p)
      },
    ],
    [
      'INVALID_FINGERPRINT',
      (b: JsonObject) => {
        ;(b.events as JsonObject[])[0].transportFingerprint = '0'.repeat(64)
      },
    ],
    [
      'EVENT_TOO_LARGE',
      (b: JsonObject) => {
        ;(b.events as JsonObject[])[0].payloadCanonical = 'é'.repeat(131073)
      },
    ],
  ])('reports %s', (code, mutate) => {
    const b = structuredClone(fixture)
    mutate(b)
    expect(() => validateSync(JSON.stringify(b), 'ledger-ingest-v1')).toThrow(code)
  })
})

describe('Edge request boundary', () => {
  it('requires JWT before any proof or financial call', async () => {
    const d = deps()
    const r = request(JSON.stringify(fixture))
    r.headers.delete('authorization')
    expect((await handleSync(r, 'ledger-ingest-v1', d)).status).toBe(401)
    expect(d.transact).not.toHaveBeenCalled()
    expect(d.proofRpc).not.toHaveBeenCalled()
  })
  it('maps expired JWT to auth pause', async () => {
    const d = deps()
    d.authenticate = async () => {
      throw new AuthFailure('SESSION_EXPIRED', 401)
    }
    const r = await handleSync(request('{}'), 'ledger-ingest-v1', d)
    expect((await r.json()).error).toEqual({
      code: 'AUTH_REQUIRED',
      category: 'auth',
      retryable: false,
    })
  })
  it('enforces the streamed byte limit', async () => {
    const d = deps()
    const r = await handleSync(request(' '.repeat(1048577)), 'ledger-ingest-v1', d)
    expect(r.status).toBe(413)
    expect(d.transact).not.toHaveBeenCalled()
  })
  it('requires possession proof', async () => {
    const d = deps()
    const r = await handleSync(request(JSON.stringify(fixture)), 'ledger-ingest-v1', d)
    expect(r.status).toBe(403)
    expect(d.transact).not.toHaveBeenCalled()
  })
  it('rejects malformed UTF-8', async () => {
    const r = new Request('https://test.invalid', {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: new Uint8Array([0xff]),
    })
    expect((await handleSync(r, 'ledger-ingest-v1', deps())).status).toBe(422)
  })
  it('rejects compressed and insecure production requests', async () => {
    expect(
      (await handleSync(request('{}', { 'Content-Encoding': 'gzip' }), 'ledger-ingest-v1', deps()))
        .status,
    ).toBe(400)
    const r = new Request('http://remote.invalid', {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect((await handleSync(r, 'ledger-ingest-v1', deps())).status).toBe(400)
  })
})
