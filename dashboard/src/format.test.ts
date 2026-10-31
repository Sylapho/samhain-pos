import { describe, expect, it } from 'vitest'
import { money, dateTime } from './format'
describe('dashboard formatting', () => {
  it('keeps every cent including negative sub-euro values and the largest safe integer', () => {
    expect(money(-1).replace(/\s/g, '')).toBe('-0,01€')
    expect(money(101).replace(/\s/g, '')).toBe('1,01€')
    expect(money(Number.MAX_SAFE_INTEGER).replace(/\s/g, '')).toBe('90071992547409,91€')
    expect(money(null)).toBe('Indisponible')
  })
  it('formats receipts in Paris rather than the browser timezone', () => {
    expect(dateTime('2026-10-24T22:30:00Z')).toContain('25/10/2026')
    expect(dateTime(null)).toBe('Indisponible')
  })
})
