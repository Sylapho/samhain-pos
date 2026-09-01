import { posConfig } from '../config/pos'
import type { PaymentMethod } from '../types/order'

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  card: 'CB',
  cash: 'Espèces',
}

export function formatTicketMoney(cents: number): string {
  const absolute = Math.abs(cents)
  const euros = Math.floor(absolute / 100)
  const remainder = String(absolute % 100).padStart(2, '0')
  return `${cents < 0 ? '-' : ''}${euros},${remainder} €`
}

export function formatTicketDateTime(isoDate: string): { date: string; time: string } {
  const date = new Date(isoDate)
  return {
    date: new Intl.DateTimeFormat('fr-FR', {
      timeZone: posConfig.timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat('fr-FR', {
      timeZone: posConfig.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
  }
}
