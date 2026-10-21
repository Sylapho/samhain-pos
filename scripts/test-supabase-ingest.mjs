import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID, sign } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../src/utils/integrity.ts'
import { enroll, jsonRequest, managerFixture, scopeFixture } from './lib/supabase-local.mjs'
import { readCatalogVersion } from '../src/services/catalogDistribution.ts'

// Real local Auth, Edge, PostgREST and PostgreSQL. Never accepts hosted URLs/keys.
const origin = 'http://127.0.0.1:54321'
const container = 'supabase_db_samhain-pos'
function sql(input, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      { shell: false },
    )
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
      onOutput(String(c))
    })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error('Local SQL failed (details suppressed)')),
    )
    child.stdin.end(input)
  })
}
// Local CLI output is kept in memory; never printed or written to an artifact.
const cli = process.env.SAMHAIN_SUPABASE_CLI ?? 'supabase'
const cliStatus = spawnSync(cli, ['status', '-o', 'json'], { encoding: 'utf8', shell: false })
if (cliStatus.status !== 0)
  throw new Error(
    'Local Supabase status failed. On Windows set SAMHAIN_SUPABASE_CLI to supabase.exe.',
  )
const values = JSON.parse(cliStatus.stdout)
if (values.API_URL !== origin) throw new Error('Refusing a nonlocal Supabase stack.')
const publishable = values.ANON_KEY
let checks = 0
function check(condition, message) {
  assert.ok(condition, message)
  checks++
}
const organization = randomUUID(),
  festival = randomUUID()
await sql(`insert into pos_private.organizations values('${organization}',true);
insert into pos_private.festivals values('${organization}','${festival}',true);`)

const defaultScope = { organization, festival }
const enrollmentManager = await managerFixture(values, defaultScope)
async function device(scope = defaultScope, manager = enrollmentManager, dossier, previous) {
  return enroll(values, scope, manager, dossier, previous)
}

function body(d, events, head = { sequence: 0, hash: null }, endpoint = 'ledger-ingest-v1') {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    organizationId: d.organization,
    festivalId: d.festival,
    chainId: d.chain,
    installationId: d.installation,
    enrollmentGeneration: d.authorization.enrollmentGeneration,
    ...(endpoint === 'ledger-ingest-v1' ? { expectedHead: head } : {}),
    events,
  }
}
function fingerprint(d, e) {
  const { transportFingerprint: ignored, ...fields } = e
  void ignored
  return sha256Hex(
    canonicalJson({
      protocolVersion: 1,
      organizationId: d.organization,
      festivalId: d.festival,
      chainId: d.chain,
      ...fields,
    }),
  )
}
const date = '2026-10-14T08:00:00.000Z'
function event(d, id, sequence, previousHash, kind, data, profile = 'ts-ledger-v1') {
  const canonical = (v) =>
    profile === 'android-ledger-v1' ? canonicalJson(v).replaceAll('/', '\\/') : canonicalJson(v)
  const p = {
    schemaVersion: 1,
    id,
    sequence,
    previousHash,
    kind,
    recordedAt: date,
    source: {
      softwareVersion: 'fixture',
      buildMode: 'test',
      terminal: { terminalId: d.terminal, terminalCode: 'A', displayName: 'Fixture / é😀\u2028' },
      organization: {
        organizationName: 'Fixture',
        eventName: 'Fixture',
        city: '',
        address: '',
        siret: '',
        vatNumber: '',
        usesDemoPlaceholders: true,
      },
    },
    ...data,
  }
  p.hash = sha256Hex(canonical(p))
  const e = {
    eventId: id,
    eventType: 'ledger',
    ledgerSchemaVersion: 1,
    sourceTerminalId: d.terminal,
    sequence,
    hash: p.hash,
    previousHash,
    ledgerCanonicalization: profile,
    payloadCanonical: canonical(p),
  }
  e.transportFingerprint = fingerprint(d, e)
  return e
}
function revise(d, original, modify) {
  const e = { ...original },
    p = JSON.parse(e.payloadCanonical)
  modify(p)
  delete p.hash
  const canonical = (value) =>
    e.ledgerCanonicalization === 'android-ledger-v1'
      ? canonicalJson(value).replaceAll('/', '\\/')
      : canonicalJson(value)
  p.hash = sha256Hex(canonical(p))
  e.hash = p.hash
  e.payloadCanonical = canonical(p)
  e.transportFingerprint = fingerprint(d, e)
  return e
}
function order(d, id = randomUUID(), quantity = 3) {
  return {
    id,
    orderNumber: 'A-0001',
    receiptNumber: 'R-A-0001',
    terminal: { terminalId: d.terminal, terminalCode: 'A', displayName: 'Fixture' },
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paidAt: date,
    items: [
      {
        lineId: 'line',
        productId: 'synthetic',
        name: 'Fixture',
        requiresPreparation: true,
        unitPriceCents: 101,
        quantity,
        options: [],
        ingredients: [],
        removedIngredientIds: [],
        dataConfidence: 'temporary',
        vatRate: 10,
      },
    ],
    itemCount: quantity,
    totalCents: 101 * quantity,
    createdAt: date,
    status: 'confirmed',
  }
}
async function signed(d, b, endpoint = 'ledger-ingest-v1', rawOverride) {
  const challenge = await fetch(`${origin}/functions/v1/tablet-auth-v1`, {
    method: 'POST',
    headers: {
      apikey: publishable,
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'challenge', body: { installationId: d.installation } }),
  })
  assert.equal(challenge.status, 200, 'Challenge failed')
  const { nonce } = await challenge.json(),
    raw = rawOverride ?? JSON.stringify(b)
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`samhain-auth/1\n${b.installationId}\n${endpoint}\n${nonce}\n${sha256Hex(raw)}`),
    d.keys.privateKey,
  ).toString('base64')
  return {
    raw,
    headers: {
      apikey: publishable,
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
      'X-Samhain-Nonce': nonce,
      'X-Samhain-Signature': signature,
    },
  }
}
async function sendSigned(s, endpoint = 'ledger-ingest-v1') {
  const r = await fetch(`${origin}/functions/v1/${endpoint}`, {
    method: 'POST',
    headers: s.headers,
    body: s.raw,
  })
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Edge returned non-JSON HTTP ${r.status}`)
  }
  return { status: r.status, data }
}
async function send(d, b, endpoint = 'ledger-ingest-v1') {
  return sendSigned(await signed(d, b, endpoint), endpoint)
}
function success(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.committed, true)
  checks++
  return r.data
}
function failure(r, code) {
  assert.equal(r.data.error?.code, code, JSON.stringify(r.data))
  check(!r.data.acknowledgements, 'No positive ACK on failure')
}
async function state(d) {
  return JSON.parse(
    await sql(`select jsonb_build_object('head',(select head_sequence from pos_private.chains where chain_id='${d.chain}'),
  'events',(select count(*) from pos_private.ledger_events where chain_id='${d.chain}'),
  'receipts',(select count(*) from pos_private.sync_receipts where chain_id='${d.chain}'),
  'sales',(select count(*) from pos_private.sales where chain_id='${d.chain}'))`),
  )
}

const d = await device()
const open = event(d, 'opaque-session', 1, null, 'cash_session_opened', {
  session: { sessionId: 'session', periodStart: date, createdAt: date, openingFloatCents: 0 },
})
const first = success(await send(d, body(d, [open])))
const retry = success(await send(d, body(d, [open])))
const third = success(await send(d, body(d, [open])))
check(
  first.acknowledgements[0].status === 'accepted' &&
    retry.acknowledgements[0].status === 'already_present',
  'Replay status',
)
check(
  first.acknowledgements[0].receiptId === third.acknowledgements[0].receiptId &&
    first.acknowledgements[0].serverReceivedAt === third.acknowledgements[0].serverReceivedAt,
  'Receipt and first date survive lost response',
)
check((await state(d)).events === 1, 'Triple retry writes once')
const changed = event(d, open.eventId, 1, null, 'cash_session_opened', {
  session: { sessionId: 'session', periodStart: date, createdAt: date, openingFloatCents: 1 },
})
failure(await send(d, body(d, [changed])), 'EVENT_CONTENT_CONFLICT')
const liar = { ...changed, hash: open.hash }
const lp = JSON.parse(liar.payloadCanonical)
lp.hash = open.hash
liar.payloadCanonical = canonicalJson(lp)
liar.transportFingerprint = fingerprint(d, liar)
failure(await send(d, body(d, [liar])), 'INVALID_HASH')
const fork = event(d, 'other-id', 1, null, 'cash_session_opened', {
  session: { sessionId: 'other', periodStart: date, createdAt: date, openingFloatCents: 0 },
})
failure(await send(d, body(d, [fork])), 'SEQUENCE_FORK')

const saleOrder = order(d)
const sale = event(d, 'opaque-sale', 2, open.hash, 'sale', {
  orderId: saleOrder.id,
  order: saleOrder,
})
const invalid = event(d, 'bad-float', 3, sale.hash, 'cash_float_updated', {
  cashFloatUpdate: {
    operationId: 'bad',
    sessionId: 'session',
    previousOpeningFloatCents: 1,
    newOpeningFloatCents: 100,
    updatedAt: date,
  },
})
failure(
  await send(d, body(d, [sale, invalid], { sequence: 1, hash: open.hash })),
  'BUSINESS_INCONSISTENCY',
)
assert.deepEqual(
  await state(d),
  { head: 1, events: 1, receipts: 1, sales: 0 },
  'Invalid second event rolls back first event, projection, receipt and head',
)
checks++
const gap = event(d, 'gap', 4, open.hash, 'sale', { orderId: saleOrder.id, order: saleOrder })
failure(await send(d, body(d, [gap], { sequence: 1, hash: open.hash })), 'MISSING_PREDECESSOR')
const midBatchGap = event(d, 'mid-gap', 4, sale.hash, 'cash_float_updated', {
  cashFloatUpdate: {
    operationId: 'mid-gap',
    sessionId: 'session',
    previousOpeningFloatCents: 0,
    newOpeningFloatCents: 100,
    updatedAt: date,
  },
})
const gapResponse = await send(d, body(d, [sale, midBatchGap], { sequence: 1, hash: open.hash }))
failure(gapResponse, 'MISSING_PREDECESSOR')
check(
  gapResponse.data.error.eventId === midBatchGap.eventId && (await state(d)).head === 1,
  'Gap inside a batch is recoverable and rolls back its valid prefix',
)
failure(await send(d, body(d, [sale])), 'HEAD_MOVED')
const update = event(
  d,
  'opaque-float',
  3,
  sale.hash,
  'cash_float_updated',
  {
    cashFloatUpdate: {
      operationId: 'float',
      sessionId: 'session',
      previousOpeningFloatCents: 0,
      newOpeningFloatCents: 100,
      updatedAt: date,
    },
  },
  'android-ledger-v1',
)
success(await send(d, body(d, [open, sale, update], { sequence: 1, hash: open.hash })))
check((await state(d)).events === 3, 'Mixed replay and new batch')
const refund = event(d, 'opaque-refund', 4, update.hash, 'correction', {
  correction: {
    operationId: 'refund',
    originalOrderId: saleOrder.id,
    originalOrderNumber: saleOrder.orderNumber,
    originalReceiptNumber: saleOrder.receiptNumber,
    type: 'refund',
    reason: 'Fixture',
    amountDeltaCents: -101,
    paymentMethod: 'cash',
    originalSaleHash: sale.hash,
    refundLines: [
      {
        originalLineId: 'line',
        productId: 'synthetic',
        productName: 'Fixture',
        quantity: 1,
        unitPriceCents: 101,
        vatRate: 10,
        grossCents: 101,
        vatCents: 9,
      },
    ],
  },
})
for (const modify of [
  (p) => {
    p.correction.refundLines[0].vatCents = 10
  },
  (p) => {
    p.correction.originalReceiptNumber = 'forged-reference'
  },
  (p) => {
    p.correction.refundLines[0].quantity = 4
    p.correction.amountDeltaCents = -404
  },
  (p) => {
    p.correction.paymentMethod = 'card'
  },
])
  failure(
    await send(d, body(d, [revise(d, refund, modify)], { sequence: 3, hash: update.hash })),
    'BUSINESS_INCONSISTENCY',
  )
success(await send(d, body(d, [refund], { sequence: 3, hash: update.hash })))
const close = event(d, 'opaque-closure', 5, refund.hash, 'closure', {
  closure: {
    operationId: 'close',
    periodStart: date,
    periodEnd: '2026-10-14T09:00:00.000Z',
    cashSessionId: 'session',
    openingFloatCents: 100,
    theoreticalCashCents: 302,
    totals: {
      saleCount: 1,
      grossSalesCents: 303,
      correctionCount: 1,
      correctionTotalCents: -101,
      netTotalCents: 202,
      cumulativeNetTotalCents: 202,
      paymentTotalsCents: { cash: 202, card: 0 },
    },
  },
})
const cp = JSON.parse(close.payloadCanonical)
cp.recordedAt = '2026-10-14T09:00:00.000Z'
delete cp.hash
cp.hash = sha256Hex(canonicalJson(cp))
close.hash = cp.hash
close.payloadCanonical = canonicalJson(cp)
close.transportFingerprint = fingerprint(d, close)
failure(
  await send(
    d,
    body(
      d,
      [
        revise(d, close, (p) => {
          p.closure.totals.grossSalesCents++
        }),
      ],
      { sequence: 4, hash: refund.hash },
    ),
  ),
  'BUSINESS_INCONSISTENCY',
)
failure(
  await send(
    d,
    body(
      d,
      [
        revise(d, close, (p) => {
          p.closure.openingFloatCents++
        }),
      ],
      { sequence: 4, hash: refund.hash },
    ),
  ),
  'BUSINESS_INCONSISTENCY',
)
success(await send(d, body(d, [close], { sequence: 4, hash: refund.hash })))
check((await state(d)).head === 5, 'All five kinds committed')

const prefix = body(
  d,
  [
    {
      sequence: 1,
      eventId: open.eventId,
      hash: open.hash,
      transportFingerprint: open.transportFingerprint,
    },
    {
      sequence: 2,
      eventId: 'wrong',
      hash: sale.hash,
      transportFingerprint: sale.transportFingerprint,
    },
  ],
  undefined,
  'ledger-prefix-v1',
)
const diagnostic = await send(d, prefix, 'ledger-prefix-v1')
check(
  diagnostic.status === 200 &&
    diagnostic.data.results[0].status === 'match' &&
    diagnostic.data.results[1].status === 'conflict',
  'Prefix compares actual tuples',
)
check(
  !('acknowledgements' in diagnostic.data) && !('committed' in diagnostic.data),
  'Prefix is never an ACK',
)
check((await state(d)).head === 5, 'Prefix leaves head unchanged')

const legacyOrder = order(d, randomUUID(), 1)
delete legacyOrder.terminal
legacyOrder.registerName = 'Historical fixture'
const legacy = {
  eventId: legacyOrder.id,
  eventType: 'legacy_order',
  ledgerSchemaVersion: null,
  sourceTerminalId: d.terminal,
  sequence: null,
  hash: null,
  previousHash: null,
  ledgerCanonicalization: null,
  payloadCanonical: canonicalJson(legacyOrder),
}
legacy.transportFingerprint = fingerprint(d, legacy)
const legacyAck = success(
  await send(d, body(d, [legacy], undefined, 'legacy-import-v1'), 'legacy-import-v1'),
)
const legacyRetry = success(
  await send(d, body(d, [legacy], undefined, 'legacy-import-v1'), 'legacy-import-v1'),
)
const legacyChanged = {
  ...legacy,
  payloadCanonical: canonicalJson({ ...legacyOrder, registerName: 'Different fixture' }),
}
legacyChanged.transportFingerprint = fingerprint(d, legacyChanged)
failure(
  await send(d, body(d, [legacyChanged], undefined, 'legacy-import-v1'), 'legacy-import-v1'),
  'EVENT_CONTENT_CONFLICT',
)
check(
  legacyAck.acknowledgements[0].sequence === null &&
    legacyAck.acknowledgements[0].receiptId === legacyRetry.acknowledgements[0].receiptId &&
    (await state(d)).head === 5,
  'Legacy replay has receipt but no financial sequence/head',
)
const missingPrefix = await send(
  d,
  body(
    d,
    [
      {
        sequence: 6,
        eventId: 'absent',
        hash: '0'.repeat(64),
        transportFingerprint: '0'.repeat(64),
      },
    ],
    undefined,
    'ledger-prefix-v1',
  ),
  'ledger-prefix-v1',
)
check(
  missingPrefix.status === 200 && missingPrefix.data.results[0].status === 'absent',
  'Prefix can diagnose an absent suffix',
)
const legacyCorrection = revise(
  d,
  event(d, 'legacy-correction', 6, close.hash, 'correction', {
    correction: {
      operationId: 'legacy-refund',
      originalOrderId: legacyOrder.id,
      originalOrderNumber: legacyOrder.orderNumber,
      originalReceiptNumber: legacyOrder.receiptNumber,
      type: 'refund',
      reason: 'Historical amount-only fixture',
      amountDeltaCents: -101,
      paymentMethod: 'cash',
      originalSaleHash: null,
    },
  }),
  (p) => {
    p.recordedAt = '2026-10-14T09:00:00.000Z'
  },
)
success(await send(d, body(d, [legacyCorrection], { sequence: 5, hash: close.hash })))
check(
  (await state(d)).head === 6,
  'Historical amount-only correction references unsealed legacy sale without fabricating hash',
)
await sql(
  `update pos_private.installation_keys set continuity_state='needs_recovery' where installation_id='${d.installation}'`,
)
check(
  (await send(d, prefix, 'ledger-prefix-v1')).status === 200,
  'Prefix remains available to an authorized installation in recovery',
)
failure(await send(d, body(d, [open])), 'ACCESS_REVOKED')

check(
  (await send(d, body(d, [], undefined, 'ledger-prefix-v1'), 'ledger-prefix-v1')).data.serverHead
    .sequence === 6,
  'Empty prefix request is a head diagnostic without an ACK',
)

const historical = await device(),
  terminal2 = `historical-${randomUUID()}`
await sql(`update pos_private.terminal_ranges set last_sequence=1 where chain_id='${historical.chain}';
insert into pos_private.terminal_ranges(organization_id,festival_id,chain_id,first_sequence,terminal_id,evidence_reference)
values('${organization}','${festival}','${historical.chain}',2,'${terminal2}','synthetic-approved-history');`)
const oldOrder = order(historical),
  newIdentity = { ...historical, terminal: terminal2 },
  newOrder = order(newIdentity)
const oldSale = event(historical, 'old-terminal', 1, null, 'sale', {
  orderId: oldOrder.id,
  order: oldOrder,
})
const newSale = event(newIdentity, 'new-terminal', 2, oldSale.hash, 'sale', {
  orderId: newOrder.id,
  order: newOrder,
})
success(await send(historical, body(historical, [oldSale, newSale])))
const returnedOrder = order(historical)
const returnedSale = event(historical, 'returned-terminal', 3, newSale.hash, 'sale', {
  orderId: returnedOrder.id,
  order: returnedOrder,
})
failure(
  await send(historical, body(historical, [returnedSale], { sequence: 2, hash: newSale.hash })),
  'SCOPE_DENIED',
)
await sql(`update pos_private.terminal_ranges set last_sequence=2 where chain_id='${historical.chain}' and first_sequence=2;
insert into pos_private.terminal_ranges(organization_id,festival_id,chain_id,first_sequence,terminal_id,evidence_reference)
values('${organization}','${festival}','${historical.chain}',3,'${historical.terminal}','synthetic-approved-return');`)
success(
  await send(historical, body(historical, [returnedSale], { sequence: 2, hash: newSale.hash })),
)
check(
  (await state(historical)).head === 3,
  'Historical terminal may recur only inside its approved sequence ranges',
)
const cancellation = event(historical, 'cancellation', 4, returnedSale.hash, 'correction', {
  correction: {
    operationId: 'cancel',
    originalOrderId: oldOrder.id,
    originalOrderNumber: oldOrder.orderNumber,
    originalReceiptNumber: oldOrder.receiptNumber,
    type: 'cancellation',
    reason: 'Fixture',
    amountDeltaCents: -303,
    paymentMethod: 'cash',
    originalSaleHash: oldSale.hash,
  },
})
success(
  await send(
    historical,
    body(historical, [cancellation], { sequence: 3, hash: returnedSale.hash }),
  ),
)
const adjustment = event(historical, 'adjustment', 5, cancellation.hash, 'correction', {
  correction: {
    operationId: 'adjust',
    originalOrderId: newOrder.id,
    originalOrderNumber: newOrder.orderNumber,
    originalReceiptNumber: newOrder.receiptNumber,
    type: 'adjustment',
    reason: 'Historical fixture',
    amountDeltaCents: 1,
    paymentMethod: 'cash',
    originalSaleHash: newSale.hash,
  },
})
success(
  await send(historical, body(historical, [adjustment], { sequence: 4, hash: cancellation.hash })),
)
const historicalClosure = revise(
  historical,
  event(historical, 'historical-closure', 6, adjustment.hash, 'closure', {
    closure: {
      operationId: 'historical-close',
      periodStart: date,
      periodEnd: '2026-10-14T09:00:00.000Z',
      totals: {
        saleCount: 3,
        grossSalesCents: 909,
        correctionCount: 2,
        correctionTotalCents: -302,
        netTotalCents: 607,
        cumulativeNetTotalCents: 607,
        paymentTotalsCents: { cash: 607, card: 0 },
      },
    },
  }),
  (p) => {
    p.recordedAt = '2026-10-14T09:00:00.000Z'
  },
)
success(
  await send(
    historical,
    body(historical, [historicalClosure], { sequence: 5, hash: adjustment.hash }),
  ),
)
check(
  (await state(historical)).head === 6,
  'Historical closure without cash session, cancellation and adjustment stay supported',
)

// Concurrent connections, independent chains, copied order identity and revoked registrations.
const other = await device(),
  independent = await device()
const sale2Order = order(other),
  sale2 = event(other, 'concurrent-sale', 1, null, 'sale', {
    orderId: sale2Order.id,
    order: sale2Order,
  })
const nonce1 = await signed(other, body(other, [sale2]))
const concurrency = await Promise.all([sendSigned(nonce1), sendSigned(nonce1)])
check(
  concurrency.filter((r) => r.status === 200).length === 1 &&
    concurrency.filter((r) => r.status === 403).length === 1,
  'Single nonce under concurrent ingestion',
)
success(await send(other, body(other, [sale2])))
check((await state(other)).sales === 1, 'Concurrency and retry write once')

// A real row lock produces the v1 temporary transaction diagnostic, never a positive ACK.
const lockedRequest = await signed(other, body(other, [sale2]))
let signalLock
const locked = new Promise((resolve) => {
  signalLock = resolve
})
const locker = sql(
  `begin;select 1 from pos_private.chains where chain_id='${other.chain}' for update;
select 'LOCKED';select pg_sleep(6);commit;`,
  (chunk) => {
    if (chunk.includes('LOCKED')) signalLock()
  },
)
await locked
const timedOut = await sendSigned(lockedRequest)
failure(timedOut, 'TRANSACTION_RETRY')
check(
  timedOut.status === 503 &&
    timedOut.data.error.retryable &&
    timedOut.data.error.category === 'temporary',
  'Lock timeout is retryable',
)
await locker
success(await sendSigned(lockedRequest))
check(
  (await state(other)).events === 1,
  'Rollback preserves challenge for safe retry and one financial event',
)

const separateOrder = order(independent),
  separate = event(independent, 'independent-sale', 1, null, 'sale', {
    orderId: separateOrder.id,
    order: separateOrder,
  })
const concurrently = await Promise.all([
  send(other, body(other, [sale2])),
  send(independent, body(independent, [separate])),
])
concurrently.forEach(success)
check((await state(independent)).sales === 1, 'Independent chains accept colliding display numbers')
const copiedOrder = {
  ...sale2Order,
  terminal: { ...sale2Order.terminal, terminalId: independent.terminal },
}
const copied = event(independent, 'copied', 2, separate.hash, 'sale', {
  orderId: copiedOrder.id,
  order: copiedOrder,
})
failure(
  await send(independent, body(independent, [copied], { sequence: 1, hash: separate.hash })),
  'DUPLICATE_ORDER_OTHER_CHAIN',
)

const replayProof = await signed(independent, body(independent, [separate]))
success(await sendSigned(replayProof))
failure(await sendSigned(replayProof), 'ACCESS_REVOKED')
const badProof = await signed(independent, body(independent, [separate]))
badProof.headers['X-Samhain-Signature'] = Buffer.alloc(256).toString('base64')
failure(await sendSigned(badProof), 'ACCESS_REVOKED')
const wrongScope = { ...body(independent, [{ ...separate }]), festivalId: randomUUID() }
const { transportFingerprint: _wrongFingerprint, ...wrongFields } = wrongScope.events[0]
void _wrongFingerprint
wrongScope.events[0].transportFingerprint = sha256Hex(
  canonicalJson({
    protocolVersion: 1,
    organizationId: organization,
    festivalId: wrongScope.festivalId,
    chainId: independent.chain,
    ...wrongFields,
  }),
)
failure(await send(independent, wrongScope), 'SCOPE_DENIED')
const forged = event(independent, 'forged', 2, separate.hash, 'sale', {
  orderId: randomUUID(),
  order: order({ ...independent, terminal: 'forged' }),
})
const fp = JSON.parse(forged.payloadCanonical)
fp.orderId = fp.order.id
fp.source.terminal.terminalId = 'forged'
delete fp.hash
fp.hash = sha256Hex(canonicalJson(fp))
forged.sourceTerminalId = 'forged'
forged.hash = fp.hash
forged.payloadCanonical = canonicalJson(fp)
forged.transportFingerprint = fingerprint(independent, forged)
failure(
  await send(independent, body(independent, [forged], { sequence: 1, hash: separate.hash })),
  'SCOPE_DENIED',
)

const empty = await device()
const revokedDuringUpload = await device(),
  revokedOrder = order(revokedDuringUpload)
const rejectedSale = event(revokedDuringUpload, 'revoked-before-commit', 1, null, 'sale', {
  orderId: revokedOrder.id,
  order: revokedOrder,
})
const pendingRevocation = await signed(
  revokedDuringUpload,
  body(revokedDuringUpload, [rejectedSale]),
)
let signalRevocation
const revoking = new Promise((resolve) => {
  signalRevocation = resolve
})
const revoker = sql(
  `begin;select 1 from pos_private.chains where chain_id='${revokedDuringUpload.chain}' for update;
update pos_private.installations set active=false,revoked_at=now() where installation_id='${revokedDuringUpload.installation}';
select 'REVOKING';select pg_sleep(0.5);commit;`,
  (chunk) => {
    if (chunk.includes('REVOKING')) signalRevocation()
  },
)
await revoking
failure(await sendSigned(pendingRevocation), 'INSTALLATION_RETIRED')
await revoker
check(
  (await state(revokedDuringUpload)).events === 0,
  'Concurrent revocation committed first excludes new financial writes',
)

const missing = event(empty, 'correction-first', 1, null, 'correction', {
  correction: {
    operationId: 'missing',
    originalOrderId: randomUUID(),
    originalOrderNumber: 'A-0001',
    originalReceiptNumber: 'R-A-0001',
    type: 'refund',
    reason: 'Fixture',
    amountDeltaCents: -1,
    paymentMethod: 'cash',
    originalSaleHash: null,
  },
})
failure(await send(empty, body(empty, [missing])), 'DEPENDENCY_MISSING')
check((await state(empty)).events === 0, 'Missing sale causes no writes')
const noJwt = await fetch(`${origin}/functions/v1/ledger-ingest-v1`, {
  method: 'POST',
  headers: { apikey: publishable, 'Content-Type': 'application/json' },
  body: '{}',
})
check(noJwt.status === 401, 'Missing JWT denied by gateway')
const invalidJwt = await fetch(`${origin}/functions/v1/ledger-ingest-v1`, {
  method: 'POST',
  headers: {
    apikey: publishable,
    Authorization: 'Bearer invalid',
    'Content-Type': 'application/json',
  },
  body: '{}',
})
check(invalidJwt.status === 401, 'Invalid JWT denied')

const bulk = await device(),
  hundred = []
for (let sequence = 1; sequence <= 100; sequence++) {
  const snapshot = order(bulk)
  hundred.push(
    event(bulk, `event-${sequence}`, sequence, hundred.at(-1)?.hash ?? null, 'sale', {
      orderId: snapshot.id,
      order: snapshot,
    }),
  )
}
success(await send(bulk, body(bulk, hundred)))
check(
  (await state(bulk)).events === 100 && (await state(bulk)).receipts === 100,
  'Exactly 100 events commit atomically',
)
failure(await send(bulk, body(bulk, [...hundred, hundred[0]])), 'BATCH_TOO_LARGE')
const sizedBody = body(bulk, [hundred[0]]),
  sizedRaw = JSON.stringify(sizedBody)
const exactlyOneMiB = sizedRaw + ' '.repeat(1048576 - Buffer.byteLength(sizedRaw))
success(await sendSigned(await signed(bulk, sizedBody, 'ledger-ingest-v1', exactlyOneMiB)))
failure(
  await sendSigned(await signed(bulk, sizedBody, 'ledger-ingest-v1', exactlyOneMiB + ' ')),
  'BATCH_TOO_LARGE',
)
failure(
  await send(
    bulk,
    body(
      bulk,
      [
        revise(
          bulk,
          event(bulk, 'invalid-cents', 101, hundred.at(-1).hash, 'sale', {
            orderId: 'invalid-cents',
            order: order(bulk, 'invalid-cents'),
          }),
          (p) => {
            p.order.totalCents = -1
          },
        ),
      ],
      { sequence: 100, hash: hundred.at(-1).hash },
    ),
  ),
  'INVALID_PAYLOAD',
)

const unknown = await send(independent, { ...body(independent, [separate]), protocolVersion: 2 })
failure(unknown, 'PROTOCOL_UNSUPPORTED')
check(
  unknown.data.error.category === 'recovery' && !unknown.data.error.retryable,
  'Unknown versions need recovery',
)
const pending = await signed(empty, body(empty, [missing]))
await sql(`delete from auth.sessions where id='${empty.session}'`)
failure(await sendSigned(pending), 'AUTH_REQUIRED')
await sql(`update pos_private.installations set active=false,revoked_at=now() where installation_id='${independent.installation}';
update pos_private.chains set enrollment_generation=enrollment_generation+1 where chain_id='${independent.chain}';`)
failure(await send(independent, body(independent, [separate])), 'INSTALLATION_RETIRED')
check(
  (await state(independent)).events === 1,
  'Revoked/replaced installation cannot modify history',
)
// #115 uses the same live Auth/proof infrastructure, with an independent catalogue RPC.
const catalogDevice = await device()
const catalogContext = {
  action: 'read',
  organizationId: organization,
  festivalId: festival,
  chainId: catalogDevice.chain,
  installationId: catalogDevice.installation,
  enrollmentGeneration: 1,
}
let catalogue = await send(catalogDevice, catalogContext, 'catalog-v1')
check(
  catalogue.status === 200 && catalogue.data.version === null,
  `No fabricated catalogue before first publication (HTTP ${catalogue.status}, ${catalogue.data.code ?? 'no code'})`,
)
const email = `catalog-${randomUUID()}@example.invalid`
const password = randomUUID() + randomUUID()
const created = await fetch(`${origin}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: values.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${values.SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ email, password, email_confirm: true }),
})
assert.equal(created.status, 200, 'Local manager setup failed')
const manager = await created.json()
const loggedIn = await fetch(`${origin}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: publishable, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
assert.equal(loggedIn.status, 200, 'Local manager login failed')
const managerAuth = await loggedIn.json()
const catalogBody = {
  action: 'publish',
  organizationId: organization,
  festivalId: festival,
  expectedRevision: 0,
  products: [
    {
      id: 'fixture-product',
      name: 'Synthetic catalogue é😀 / fixture',
      priceCents: 500,
      vatRate: 10,
      categoryId: 'fixture-category',
      active: true,
      displayOrder: 0,
      requiresPreparation: false,
      availability: 'available',
      dataConfidence: 'confirmed',
    },
  ],
  categories: [
    { id: 'fixture-category', label: 'Synthetic fixture', active: true, displayOrder: 0 },
  ],
}
const publishCatalog = async (body) => {
  const response = await fetch(`${origin}/functions/v1/catalog-v1`, {
    method: 'POST',
    headers: {
      apikey: publishable,
      Authorization: `Bearer ${managerAuth.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() }
}
check(
  (await publishCatalog(catalogBody)).status === 403,
  'Unprivileged live manager cannot publish',
)
await sql(
  `insert into pos_private.scope_grants values('${organization}','${festival}','${manager.id}','publish_catalog',true)`,
)
const publication = await publishCatalog(catalogBody)
check(publication.status === 200, 'Scoped manager publishes a complete version')
const publicationDocument = readCatalogVersion(publication.data.version, {
  organizationId: organization,
  festivalId: festival,
})
check(
  publicationDocument.revision === 1 && publicationDocument.origin === `supabase:${manager.id}`,
  'Server generates revision and origin; SHA-256 verifies on client',
)
check((await publishCatalog(catalogBody)).status === 409, 'Stale manager publication rejected')
check(
  (
    await publishCatalog({
      ...catalogBody,
      expectedRevision: 1,
      products: [{ ...catalogBody.products[0], categoryId: 'absent' }],
    })
  ).status === 400,
  'Invalid references rejected through real Edge',
)
catalogue = await send(catalogDevice, catalogContext, 'catalog-v1')
check(
  catalogue.status === 200 && catalogue.data.version.sha256 === publication.data.version.sha256,
  'Second device downloads exact published document',
)
const simultaneous = await Promise.all([
  publishCatalog({ ...catalogBody, expectedRevision: 1 }),
  publishCatalog({ ...catalogBody, expectedRevision: 1 }),
])
check(
  simultaneous
    .map((response) => response.status)
    .sort()
    .join(',') === '200,409',
  'Concurrent catalogue publications have exactly one winner',
)
const forgedCatalog = await send(
  catalogDevice,
  { ...catalogContext, festivalId: randomUUID() },
  'catalog-v1',
)
check(forgedCatalog.status === 403, 'Signed forged catalogue scope denied')
await sql(
  `update pos_private.scope_grants set active=false where auth_subject='${manager.id}' and capability='publish_catalog'`,
)
check(
  (await publishCatalog({ ...catalogBody, expectedRevision: 2 })).status === 403,
  'Publisher revocation applies with unexpired token',
)
const beforeCatalogRevoke = await signed(catalogDevice, catalogContext, 'catalog-v1')
await sql(
  `update pos_private.installations set active=false,revoked_at=now() where installation_id='${catalogDevice.installation}'`,
)
check(
  (await sendSigned(beforeCatalogRevoke, 'catalog-v1')).status === 403,
  'Tablet revocation applies to a previously signed catalogue download',
)
check(
  (await state(independent)).events === 1,
  'Catalogue publication never rewrites financial history',
)
// #117: a second real scope, authentic enrollment/replacement and session lifecycle.
const secondScope = await scopeFixture()
const secondManager = await managerFixture(values, secondScope)
const scopedDevice = await device(secondScope, secondManager)
const scopedOrder = order(scopedDevice)
const scopedSale = event(scopedDevice, 'scope-sale', 1, null, 'sale', {
  orderId: scopedOrder.id,
  order: scopedOrder,
})
success(await send(scopedDevice, body(scopedDevice, [scopedSale])))
const scopedBefore = await state(scopedDevice)
const refreshed = await jsonRequest('/auth/v1/token?grant_type=refresh_token', publishable, null, {
  refresh_token: scopedDevice.refresh,
})
check(
  refreshed.status === 200 && refreshed.data.user.id === scopedDevice.subject,
  'Real Auth refresh preserves tablet principal',
)
scopedDevice.token = refreshed.data.access_token
success(await send(scopedDevice, body(scopedDevice, [scopedSale])))
const foreignChain = { ...body(scopedDevice, [scopedSale]), chainId: historical.chain }
const { transportFingerprint: ignoredForeignFingerprint, ...foreignFields } = scopedSale
void ignoredForeignFingerprint
foreignChain.events = [
  {
    ...scopedSale,
    transportFingerprint: sha256Hex(
      canonicalJson({
        protocolVersion: 1,
        organizationId: scopedDevice.organization,
        festivalId: scopedDevice.festival,
        chainId: historical.chain,
        ...foreignFields,
      }),
    ),
  },
]
failure(await send(scopedDevice, foreignChain), 'SCOPE_DENIED')
failure(
  await send(scopedDevice, {
    ...body(scopedDevice, [scopedSale]),
    installationId: historical.installation,
  }),
  'ACCESS_REVOKED',
)
const forbiddenApproval = await fetch(`${origin}/functions/v1/tablet-auth-v1`, {
  method: 'POST',
  headers: {
    apikey: publishable,
    Authorization: `Bearer ${secondManager.token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    action: 'revoke',
    body: { chainId: historical.chain, installationId: historical.installation },
  }),
})
check(forbiddenApproval.status === 403, 'Real manager of another scope cannot revoke a tablet')
for (const token of [publishable, secondManager.token, scopedDevice.token]) {
  for (const rpc of [
    'tablet_auth_v1',
    'ledger_ingest_v1',
    'legacy_import_v1',
    'ledger_prefix_v1',
    'catalog_v1',
  ]) {
    const direct = await fetch(`${origin}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: {
        apikey: publishable,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        rpc === 'tablet_auth_v1'
          ? { subject: scopedDevice.subject, action: 'status', body: {}, proof_nonce: null }
          : rpc === 'catalog_v1'
            ? {
                subject: scopedDevice.subject,
                session_id: scopedDevice.session,
                body: {},
                proof_nonce: null,
              }
            : {
                subject: scopedDevice.subject,
                session_id: scopedDevice.session,
                raw_body: '{}',
                proof_nonce: null,
              },
      ),
    })
    check([401, 403].includes(direct.status), 'Direct privileged RPC denied with real API roles')
  }
}
assert.deepEqual(
  await state(scopedDevice),
  scopedBefore,
  'Foreign requests cannot alter the scoped chain',
)
checks++
const sessionProof = await signed(scopedDevice, body(scopedDevice, [scopedSale]))
await sql(
  `update auth.sessions set not_after=now()-interval '1 second' where id='${scopedDevice.session}'`,
)
failure(await sendSigned(sessionProof), 'AUTH_REQUIRED')

const replacementSource = await device()
const replacementOrder = order(replacementSource)
const replacementSale = event(replacementSource, 'replacement-sale', 1, null, 'sale', {
  orderId: replacementOrder.id,
  order: replacementOrder,
})
success(await send(replacementSource, body(replacementSource, [replacementSale])))
const originalState = await state(replacementSource)
const dossier = {
  chainId: replacementSource.chain,
  terminalId: replacementSource.terminal,
  restored: true,
  prefix: [],
}
const oldArchive = await device(defaultScope, enrollmentManager, dossier, replacementSource)
check(
  oldArchive.authorization.status === 'needs_recovery' &&
    oldArchive.authorization.serverHead.sequence === 1,
  'Archive older than real server head requires recovery',
)
failure(await send(oldArchive, body(oldArchive, [replacementSale])), 'ACCESS_REVOKED')
failure(
  await send(replacementSource, body(replacementSource, [replacementSale])),
  'INSTALLATION_RETIRED',
)
const truePrefix = [
  {
    sequence: 1,
    eventId: replacementSale.eventId,
    hash: replacementSale.hash,
    terminalId: replacementSource.terminal,
  },
]
const forkedArchive = await device(
  defaultScope,
  enrollmentManager,
  { ...dossier, prefix: [{ ...truePrefix[0], hash: 'a'.repeat(64) }] },
  oldArchive,
)
check(
  forkedArchive.authorization.status === 'needs_recovery',
  'Divergent restored copy cannot activate uploads',
)
const restored = await device(
  defaultScope,
  enrollmentManager,
  { ...dossier, prefix: truePrefix },
  forkedArchive,
)
check(
  restored.authorization.status === 'authorized' &&
    restored.authorization.enrollmentGeneration === 4,
  'Exact restored prefix permits explicitly approved reenrollment with new generation',
)
const restoredAck = success(await send(restored, body(restored, [replacementSale])))
check(
  restoredAck.acknowledgements[0].status === 'already_present',
  'Restoration uses original receipt',
)
failure(
  await send(restored, { ...body(restored, [replacementSale]), enrollmentGeneration: 1 }),
  'INSTALLATION_RETIRED',
)
assert.deepEqual(
  await state(restored),
  originalState,
  'Recovery never rewrites financial events, receipts, projection or head',
)
checks++
// Optional financial fields remain sealed; unknown protocol extensions fail explicitly.
failure(
  await send(restored, { ...body(restored, [replacementSale]), futureField: true }),
  'INVALID_ENVELOPE',
)
failure(
  await send(restored, body(restored, [{ ...replacementSale, ledgerSchemaVersion: 2 }])),
  'LEDGER_SCHEMA_UNSUPPORTED',
)
console.log(
  `PASS: ${checks} real local Auth/Edge/PostgreSQL checks; ledger and catalogue, rollback, replay, security and concurrency.`,
)
// Immutable fixtures stay in this explicitly disposable stack until the next local reset.
