import type { Order } from '../types/order'

export function getOrderTerminalDisplayName(order: Order): string {
  return order.terminal?.displayName ?? order.registerName ?? 'Ancienne caisse non identifiée'
}
