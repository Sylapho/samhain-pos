import { randomUUID } from 'node:crypto'
import { canonical, fingerprint, sha256 } from '../src/persistence/proofs.ts'
import { stable } from '../src/persistence/migrations.ts'
import type { LedgerProof } from '../src/persistence/proofs.ts'
import type { ChainScope, Head } from '../src/persistence/model.ts'

// Explicit synthetic business data used only in disposable tests.
export const terminal = { terminalId: 'test-terminal', terminalCode: 'A', displayName: 'Test' }
export const source = {
  terminal,
  softwareVersion: 'test/1',
  buildMode: 'test',
  organization: {
    organizationName: '',
    eventName: '',
    city: '',
    address: '',
    siret: '',
    vatNumber: '',
    usesDemoPlaceholders: true,
  },
}
export const recordedAt = '2026-10-24T10:00:00.000Z'
export function order(id = `order/é😀:${randomUUID()}`) {
  return {
    id,
    orderNumber: 'A-0001',
    receiptNumber: 'A-0001',
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paidAt: recordedAt,
    createdAt: recordedAt,
    status: 'confirmed',
    terminal,
    items: [
      {
        lineId: 'line/1',
        productId: 'test/1',
        name: 'Test',
        quantity: 2,
        unitPriceCents: 101,
        options: [],
        ingredients: [],
        removedIngredientIds: [],
        dataConfidence: 'temporary',
        vatRate: 10,
      },
    ],
    itemCount: 2,
    totalCents: 202,
  }
}
export function ledger(
  scope: ChainScope,
  kind = 'sale',
  value?: unknown,
  previous: Head = { sequence: 0, hash: null },
  profile: LedgerProof['ledgerCanonicalization'] = 'ts-ledger-v1',
  overrides: Record<string, unknown> = {},
) {
  const sale = value ?? order()
  const id = kind === 'sale' ? `sale:${(sale as { id: string }).id}` : `${kind}:${randomUUID()}`
  const field = {
    sale: 'order',
    correction: 'correction',
    closure: 'closure',
    cash_session_opened: 'session',
    cash_float_updated: 'cashFloatUpdate',
  }[kind]!
  const unsigned = {
    schemaVersion: 1,
    id,
    sequence: previous.sequence + 1,
    previousHash: previous.hash,
    kind,
    recordedAt,
    source,
    [field]: sale,
    ...(kind === 'sale' ? { orderId: (sale as { id: string }).id } : {}),
    ...overrides,
  }
  const hash = sha256(canonical(unsigned, profile))
  const proof: LedgerProof = {
    eventId: String(unsigned.id),
    sequence: unsigned.sequence,
    hash,
    previousHash: unsigned.previousHash,
    ledgerCanonicalization: profile,
    sourceTerminalId: terminal.terminalId,
    payloadCanonical: canonical({ ...unsigned, hash }, profile),
    transportFingerprint: '',
  }
  proof.transportFingerprint = fingerprint(scope, proof)
  return proof
}
export const head = (event: LedgerProof): Head => ({ sequence: event.sequence, hash: event.hash })
export const wire = (event: LedgerProof) => ({
  ...event,
  eventType: 'ledger',
  ledgerSchemaVersion: 1,
})
export function legacy(scope: ChainScope, value = order()) {
  const event = {
    eventId: value.id,
    sourceTerminalId: terminal.terminalId,
    payloadCanonical: stable(value),
  }
  return {
    ...event,
    eventType: 'legacy_order',
    ledgerSchemaVersion: null,
    sequence: null,
    hash: null,
    previousHash: null,
    ledgerCanonicalization: null,
    transportFingerprint: fingerprint(scope, event, true),
  }
}
export function correction(sale: LedgerProof, changes: Record<string, unknown> = {}) {
  const original = JSON.parse(sale.payloadCanonical).order as ReturnType<typeof order>
  return {
    operationId: randomUUID(),
    originalOrderId: original.id,
    originalOrderNumber: original.orderNumber,
    originalReceiptNumber: original.receiptNumber,
    type: 'refund',
    reason: 'test',
    amountDeltaCents: -101,
    paymentMethod: original.paymentMethod,
    originalSaleHash: sale.hash,
    ...changes,
  }
}
export function closure(changes: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    periodStart: '2026-10-24T00:00:00.000Z',
    periodEnd: '2026-10-24T11:00:00.000Z',
    totals: {
      saleCount: 1,
      grossSalesCents: 202,
      correctionCount: 0,
      correctionTotalCents: 0,
      netTotalCents: 202,
      cumulativeNetTotalCents: 202,
      paymentTotalsCents: { cash: 202, card: 0 },
    },
    ...changes,
  }
}
