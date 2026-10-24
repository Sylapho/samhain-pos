import { reject } from './crypto.ts'
import type { Dossier } from './types.ts'
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return reject('INVALID_ENVELOPE', 400)
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    reject('INVALID_ENVELOPE', 400)
}
export function text(value: unknown, max = 512): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes('\0')
  )
    return reject('INVALID_ENVELOPE', 400)
  return value
}
export function uuid(value: unknown): string {
  const result = text(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result))
    reject('INVALID_ENVELOPE', 400)
  return result
}
export function hash(value: unknown): string {
  const result = text(value, 64)
  if (!/^[0-9a-f]{64}$/.test(result)) reject('INVALID_ENVELOPE', 400)
  return result
}
export function dossier(value: unknown): Dossier {
  const body = record(value)
  keys(body, ['chainId', 'restored', 'terminalId', 'prefix', 'legacyOrderIds'])
  if (
    typeof body.restored !== 'boolean' ||
    !Array.isArray(body.prefix) ||
    !Array.isArray(body.legacyOrderIds) ||
    body.prefix.length >= 10000 ||
    body.legacyOrderIds.length >= 10000
  )
    return reject('RECOVERY_REQUIRED', 409)
  const ids = new Set<string>()
  const prefix = body.prefix.map((row, index) => {
    const entry = record(row)
    keys(entry, ['sequence', 'eventId', 'hash', 'terminalId'])
    if (entry.sequence !== index + 1) reject('INVALID_ENVELOPE', 400)
    const eventId = text(entry.eventId)
    if (ids.has(eventId)) reject('INVALID_ENVELOPE', 400)
    ids.add(eventId)
    return {
      sequence: index + 1,
      eventId,
      hash: hash(entry.hash),
      terminalId: text(entry.terminalId),
    }
  })
  const legacyOrderIds = body.legacyOrderIds.map((id) => text(id))
  if (new Set(legacyOrderIds).size !== legacyOrderIds.length) reject('INVALID_ENVELOPE', 400)
  return {
    chainId: uuid(body.chainId),
    restored: body.restored,
    terminalId: text(body.terminalId),
    prefix,
    legacyOrderIds,
  }
}
