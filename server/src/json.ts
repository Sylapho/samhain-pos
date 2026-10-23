import { ApiError } from './errors.ts'

// Pure parser adapted from supabase/functions/_shared/syncProtocol.ts; v1 boundary vectors in tests.
// JSON.parse alone discards duplicate keys and rounds unsafe numbers. Inspect tokens first.
export function parseStrictJson(raw: string): unknown {
  let at = 0
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(raw[at] ?? 'x')) at++
  }
  const invalid = (): never => {
    throw new ApiError(400, 'INVALID_PAYLOAD')
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
        if (unit === 0) invalid()
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
      const [mantissa = '', exponent = '0'] = token.replace(/^-/, '').split(/[eE]/)
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
