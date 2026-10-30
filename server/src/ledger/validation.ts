import { ApiError } from '../errors.ts'

export type JsonObject = Record<string, unknown>
export function fail(code = 'INVALID_PAYLOAD', status = 422): never {
  throw new ApiError(status, code)
}
export function assert(condition: unknown, code = 'BUSINESS_INCONSISTENCY'): asserts condition {
  if (!condition) fail(code)
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as JsonObject
}
export function keys(value: JsonObject, required: string[], optional: string[] = []) {
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    'INVALID_PAYLOAD',
  )
}
export function text(value: unknown, opaque = false, blank = false): string {
  if (
    typeof value !== 'string' ||
    (!blank && !value.trim()) ||
    (opaque && Buffer.byteLength(value) > 512)
  )
    fail()
  return value
}
export function integer(value: unknown, minimum = -Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail()
  return value
}
export function exact(value: bigint): number {
  assert(value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER))
  return Number(value)
}
export function add(a: number, b: number) {
  return exact(BigInt(a) + BigInt(b))
}
export function multiply(a: number, b: number) {
  return exact(BigInt(a) * BigInt(b))
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail()
  return value
}
export function date(value: unknown): string {
  const s = text(value)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,9})?Z$/.exec(s)
  if (
    !match ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`
  )
    fail()
  return s
}
// Retain nanosecond ordering without rounding a historical timestamp to milliseconds.
export function time(value: unknown): string {
  return date(value).replace(
    /(?:\.(\d+))?Z$/,
    (_whole, digits: string | undefined) => `.${(digits ?? '').padEnd(9, '0')}Z`,
  )
}
export function terminal(value: unknown): JsonObject {
  const v = object(value)
  keys(v, ['terminalId', 'terminalCode', 'displayName'])
  text(v.terminalId, true)
  text(v.displayName)
  assert(['A', 'B', 'C', 'D', 'W'].includes(text(v.terminalCode)))
  return v
}
