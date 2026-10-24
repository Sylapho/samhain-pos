import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateRequest } from '../src/ledger/protocol.ts'
import { validateOrder, validatePayload } from '../src/ledger/business.ts'
import { ApiError } from '../src/errors.ts'
import { canonical, fingerprint, sha256 } from '../src/persistence/proofs.ts'
import { add, date, multiply, time } from '../src/ledger/validation.ts'
import { syncError } from '../src/ledger/errors.ts'
import { config, fakeDatabase } from './helpers.ts'
import { buildApp } from '../src/app.ts'
import { ledger, order, wire, legacy, source } from './ledger-fixtures.ts'

const context = {
  protocolVersion: 1,
  requestId: randomUUID(),
  organizationId: randomUUID(),
  festivalId: randomUUID(),
  chainId: randomUUID(),
  installationId: randomUUID(),
  enrollmentGeneration: 1,
}
const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value
const request = (events: unknown[] = [wire(ledger(context))]) => ({
  ...context,
  expectedHead: { sequence: 0, hash: null },
  events,
})

test('accepts the published samhain-sync/1 envelope without changing its hash or fingerprint', () => {
  const doc = readFileSync(
    new URL('../../docs/architecture-supabase-offline-first.md', import.meta.url),
    'utf8',
  )
  const vector = JSON.parse(
    doc.split('<!-- sync-request-example -->')[1]!.split('```json')[1]!.split('```')[0]!,
  ) as unknown
  const validated = validateRequest(vector, 'ingest')
  for (const event of validated.events) validatePayload(JSON.parse(event.payloadCanonical))
})

test('frozen TS/Kotlin hash vectors, UTF-16 keys, escaping and null/absence', () => {
  const value = { previousHash: null, n: 9007199254740991, id: 'é😀</x>/' }
  assert.equal(
    sha256(canonical(value, 'android-ledger-v1')),
    '97dedfa5fa794d60f77027e737c065e809e9fb68466f7b8e3db14207c53d784b',
  )
  assert.equal(
    sha256(canonical(value, 'ts-ledger-v1')),
    'c81007f4eea9d748ac5a6f0341524d18d9e643dab12f0951b1ffdd379534fc70',
  )
  assert.equal(canonical({ '\ue000': 1, '😀': 2 }, 'android-ledger-v1'), '{"😀":2,"\ue000":1}')
  assert.equal(
    canonical({ s: 'é😀\u2028\u2029\n\u0001' }, 'android-ledger-v1'),
    '{"s":"é😀\u2028\u2029\\n\\u0001"}',
  )
  assert.notEqual(canonical({ v: null }, 'ts-ledger-v1'), canonical({}, 'ts-ledger-v1'))
})
for (const profile of ['ts-ledger-v1', 'android-ledger-v1'] as const)
  test(`independent ${profile} validation and opaque IDs`, () => {
    const event = ledger(context, 'sale', order(), undefined, profile)
    const validated = validateRequest(request([wire(event)]), 'ingest')
    assert.equal(validated.events[0]!.payloadCanonical, event.payloadCanonical)
    validatePayload(JSON.parse(event.payloadCanonical))
    assert.notEqual(
      event.transportFingerprint,
      fingerprint({ ...context, chainId: randomUUID() }, event),
    )
  })

test('rejects hashes, fingerprints, versions, unknown fields and noncanonical payloads explicitly', () => {
  const valid = wire(ledger(context))
  for (const [change, expected] of [
    [
      {
        hash: '0'.repeat(64),
        payloadCanonical: valid.payloadCanonical.replace(valid.hash, '0'.repeat(64)),
      },
      'INVALID_HASH',
    ],
    [{ transportFingerprint: '0'.repeat(64) }, 'INVALID_FINGERPRINT'],
    [{ ledgerSchemaVersion: 2 }, 'LEDGER_SCHEMA_UNSUPPORTED'],
    [{ ledgerCanonicalization: 'new-profile' }, 'CANONICALIZATION_UNSUPPORTED'],
    [{ payloadCanonical: ` ${valid.payloadCanonical}` }, 'INVALID_PAYLOAD'],
    [{ payloadCanonical: '{"id":1,"id":2}' }, 'INVALID_PAYLOAD'],
    [{ eventId: 'é'.repeat(257) }, 'INVALID_PAYLOAD'],
    [{ payloadCanonical: ' '.repeat(262145) }, 'EVENT_TOO_LARGE'],
  ] as const)
    assert.throws(
      () => validateRequest(request([{ ...valid, ...change }]), 'ingest'),
      code(expected),
    )
  assert.throws(
    () => validateRequest({ ...request(), protocolVersion: 2 }, 'ingest'),
    code('PROTOCOL_UNSUPPORTED'),
  )
  assert.throws(
    () => validateRequest({ ...request(), role: 'admin' }, 'ingest'),
    code('INVALID_ENVELOPE'),
  )
  assert.throws(
    () => validateRequest(request(Array(101).fill(valid)), 'ingest'),
    code('BATCH_TOO_LARGE'),
  )
  assert.throws(() => validateRequest(request([valid, valid]), 'ingest'), code('INVALID_ENVELOPE'))
})

test('strict financial snapshots, historical fields and safe exact arithmetic', () => {
  const original = order()
  validateOrder(original, source.terminal.terminalId)
  const { terminal: ignored, ...old } = original
  void ignored
  validateOrder({ ...old, registerName: 'historical' }, source.terminal.terminalId)
  validateRequest({ ...context, events: [legacy(context, original)] }, 'legacy')
  for (const value of [
    { ...original, totalCents: 201 },
    { ...original, printing: {} },
    { ...original, paymentStatus: 'pending' },
    { ...original, items: [{ ...original.items[0], quantity: 0 }] },
    {
      ...original,
      items: [{ ...original.items[0], quantity: 3, unitPriceCents: Number.MAX_SAFE_INTEGER }],
    },
  ])
    assert.throws(() => validateOrder(value, source.terminal.terminalId))
  assert.throws(() => add(Number.MAX_SAFE_INTEGER, 1))
  assert.throws(() => multiply(Number.MAX_SAFE_INTEGER, 3))
  assert.throws(() => date('2026-02-30T00:00:00Z'))
  assert.equal(time('2026-10-24T00:00:00.1Z'), time('2026-10-24T00:00:00.100000000Z'))
})

test('financial endpoints stay closed without real authentication, errors bounded and versioned', async (t) => {
  const app = await buildApp(config(), { database: fakeDatabase() })
  t.after(() => app.close())
  for (const endpoint of ['ingest', 'legacy', 'prefix']) {
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/ledger/${endpoint}`,
      payload: request(),
    })
    assert.equal(result.statusCode, 401)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.deepEqual(result.json(), {
      protocolVersion: 1,
      requestId: null,
      error: { code: 'AUTH_REQUIRED', category: 'auth', retryable: false },
    })
  }
  const large = await app.inject({
    method: 'POST',
    url: '/api/v1/ledger/ingest',
    payload: ' '.repeat(1048577),
    headers: { 'content-type': 'application/json' },
  })
  // With auth disabled the onRequest deny guard rejects before parsing.
  assert.equal(large.statusCode, 401)
  assert.equal(syncError('COMMIT_UNCERTAIN', 503, context).body.error.code, 'TRANSACTION_RETRY')
  assert.equal(syncError('PROOF_REQUIRED', 403, context).body.error.category, 'auth')
})
