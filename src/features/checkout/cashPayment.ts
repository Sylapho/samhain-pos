export const MAX_CASH_RECEIVED_CENTS = 999_999

export function appendCashDigits(
  currentCents: number | null,
  digits: number,
  maximumCents = MAX_CASH_RECEIVED_CENTS,
): number | null {
  const nextCents = (currentCents ?? 0) * 10 + digits
  return Number.isSafeInteger(nextCents) && nextCents <= maximumCents ? nextCents : currentCents
}

export function deleteLastCashDigit(currentCents: number | null): number | null {
  if (currentCents === null || currentCents < 10) return null
  return Math.floor(currentCents / 10)
}

export function getCashQuickAmounts(totalCents: number): number[] {
  if (totalCents < 0) return []

  const nextTenEuros = (Math.floor(totalCents / 1_000) + 1) * 1_000
  const nextFiftyEuros = (Math.floor(nextTenEuros / 5_000) + 1) * 5_000
  const candidates =
    totalCents < 5_000
      ? [nextTenEuros, nextTenEuros + 1_000, nextFiftyEuros]
      : [nextTenEuros, nextFiftyEuros, (Math.floor(nextFiftyEuros / 10_000) + 1) * 10_000]

  return [...new Set(candidates)]
    .filter((amount) => amount > totalCents && amount <= MAX_CASH_RECEIVED_CENTS)
    .slice(0, 3)
}
