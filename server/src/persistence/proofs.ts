import { createHash } from 'node:crypto'
import { parseStrictJson } from '../json.ts'
import { PersistenceError } from './errors.ts'
import { stable } from './migrations.ts'
import type { ChainScope, LedgerEvent, Sale } from './model.ts'

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PersistenceError('INVALID_DOCUMENT')
  return value as Record<string, unknown>
}
function opaque(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512)
    throw new PersistenceError('INVALID_DOCUMENT')
  return value
}
export type LedgerProof = Pick<
  LedgerEvent,
  | 'eventId'
  | 'sequence'
  | 'hash'
  | 'previousHash'
  | 'ledgerCanonicalization'
  | 'payloadCanonical'
  | 'transportFingerprint'
  | 'sourceTerminalId'
>
export function canonical(
  payload: unknown,
  profile: LedgerEvent['ledgerCanonicalization'],
): string {
  if (!['ts-ledger-v1', 'android-ledger-v1'].includes(profile))
    throw new PersistenceError('INVALID_DOCUMENT')
  const result = stable(payload)
  return profile === 'android-ledger-v1' ? result.replaceAll('/', '\\/') : result
}
export function fingerprint(
  scope: ChainScope,
  proof: LedgerProof | { eventId: string; sourceTerminalId: string; payloadCanonical: string },
  legacy = false,
): string {
  const ledger = 'sequence' in proof ? proof : null
  return sha256(
    stable({
      organizationId: scope.organizationId,
      festivalId: scope.festivalId,
      chainId: scope.chainId,
      protocolVersion: 1,
      eventId: proof.eventId,
      eventType: legacy ? 'legacy_order' : 'ledger',
      sourceTerminalId: proof.sourceTerminalId,
      ledgerSchemaVersion: legacy ? null : 1,
      sequence: ledger?.sequence ?? null,
      hash: ledger?.hash ?? null,
      previousHash: ledger?.previousHash ?? null,
      ledgerCanonicalization: ledger?.ledgerCanonicalization ?? null,
      payloadCanonical: proof.payloadCanonical,
    }),
  )
}

// This binds storage metadata to the original proof. Full monetary, refund and
// closure validation against the prefix belongs to #133's mandatory callback.
export function ledgerDocument(
  scope: ChainScope,
  proof: LedgerProof,
  receivedAt: Date,
): LedgerEvent {
  if (!proof.payloadCanonical || Buffer.byteLength(proof.payloadCanonical) > 262144)
    throw new PersistenceError('INVALID_DOCUMENT')
  const payload = object(parseStrictJson(proof.payloadCanonical))
  const { hash: _hash, ...unsigned } = payload
  void _hash
  if (
    payload.id !== proof.eventId ||
    payload.sequence !== proof.sequence ||
    payload.hash !== proof.hash ||
    payload.previousHash !== proof.previousHash ||
    payload.schemaVersion !== 1 ||
    object(object(payload.source).terminal).terminalId !== proof.sourceTerminalId ||
    canonical(payload, proof.ledgerCanonicalization) !== proof.payloadCanonical ||
    sha256(canonical(unsigned, proof.ledgerCanonicalization)) !== proof.hash ||
    fingerprint(scope, proof) !== proof.transportFingerprint ||
    !Number.isSafeInteger(proof.sequence) ||
    proof.sequence < 1 ||
    (proof.sequence === 1) !== (proof.previousHash === null)
  )
    throw new PersistenceError('INVALID_DOCUMENT')
  opaque(proof.eventId)
  opaque(proof.sourceTerminalId)
  const base = {
    organizationId: scope.organizationId,
    festivalId: scope.festivalId,
    chainId: scope.chainId,
    eventId: proof.eventId,
    sequence: proof.sequence,
    hash: proof.hash,
    previousHash: proof.previousHash,
    ledgerCanonicalization: proof.ledgerCanonicalization,
    payloadCanonical: proof.payloadCanonical,
    transportFingerprint: proof.transportFingerprint,
    sourceTerminalId: proof.sourceTerminalId,
    documentSchemaVersion: 1 as const,
    protocolVersion: 1 as const,
    ledgerSchemaVersion: 1 as const,
    recordedAt: opaque(payload.recordedAt),
    serverReceivedAt: receivedAt,
  }
  switch (payload.kind) {
    case 'sale': {
      const orderId = opaque(payload.orderId)
      const order = object(payload.order)
      if (order.id !== orderId || 'printing' in order || 'integrity' in order)
        throw new PersistenceError('INVALID_DOCUMENT')
      return { ...base, kind: 'sale', orderId }
    }
    case 'correction': {
      const value = object(payload.correction)
      if (!(
        value.originalSaleHash === null ||
        (typeof value.originalSaleHash === 'string' &&
          /^[0-9a-f]{64}$/.test(value.originalSaleHash))
      ))
        throw new PersistenceError('INVALID_DOCUMENT')
      return {
        ...base,
        kind: 'correction',
        operationId: opaque(value.operationId),
        originalOrderId: opaque(value.originalOrderId),
        originalSaleHash: value.originalSaleHash,
      }
    }
    case 'closure': {
      const value = object(payload.closure)
      return {
        ...base,
        kind: 'closure',
        operationId: opaque(value.operationId),
        ...('cashSessionId' in value ? { referencedSessionId: opaque(value.cashSessionId) } : {}),
      }
    }
    case 'cash_session_opened':
      return {
        ...base,
        kind: 'cash_session_opened',
        sessionId: opaque(object(payload.session).sessionId),
      }
    case 'cash_float_updated': {
      const value = object(payload.cashFloatUpdate)
      return {
        ...base,
        kind: 'cash_float_updated',
        operationId: opaque(value.operationId),
        referencedSessionId: opaque(value.sessionId),
      }
    }
    default:
      throw new PersistenceError('INVALID_DOCUMENT')
  }
}
export type LegacyProof = {
  eventId: string
  sourceTerminalId: string
  payloadCanonical: string
  transportFingerprint: string
}
export function legacyDocument(
  scope: ChainScope,
  proof: LegacyProof,
): Extract<Sale, { type: 'legacy' }> {
  if (!proof.payloadCanonical || Buffer.byteLength(proof.payloadCanonical) > 262144)
    throw new PersistenceError('INVALID_DOCUMENT')
  const payload = object(parseStrictJson(proof.payloadCanonical))
  if (
    payload.id !== proof.eventId ||
    'printing' in payload ||
    'integrity' in payload ||
    stable(payload) !== proof.payloadCanonical ||
    fingerprint(scope, proof, true) !== proof.transportFingerprint
  )
    throw new PersistenceError('INVALID_DOCUMENT')
  return {
    organizationId: scope.organizationId,
    festivalId: scope.festivalId,
    chainId: scope.chainId,
    documentSchemaVersion: 1,
    type: 'legacy',
    orderId: opaque(proof.eventId),
    protocolVersion: 1,
    sourceTerminalId: opaque(proof.sourceTerminalId),
    payloadCanonical: proof.payloadCanonical,
    transportFingerprint: proof.transportFingerprint,
  }
}
