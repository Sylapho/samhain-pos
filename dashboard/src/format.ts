const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })
export function money(cents: number | null): string {
  if (cents === null) return 'Indisponible'
  const n = BigInt(cents),
    absolute = n < 0n ? -n : n
  return (
    (n < 0n ? '-' : '') +
    currency
      .formatToParts(absolute / 100n)
      .map((p) => (p.type === 'fraction' ? String(absolute % 100n).padStart(2, '0') : p.value))
      .join('')
  )
}
export const dateTime = (at: string | null) =>
  at
    ? new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(at))
    : 'Indisponible'
