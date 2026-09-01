const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
})

export function formatMoney(cents: number): string {
  return currencyFormatter.format(cents / 100)
}
