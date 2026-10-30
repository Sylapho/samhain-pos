import type { CartItem } from '../types/cart'
import type { Order } from '../types/order'

/** W imprime un ticket de préparation pour chaque ligne de commande. */
export function getPreparationItems(order: Pick<Order, 'items'>): CartItem[] {
  return order.items
}

export function orderRequiresPreparation(order: Pick<Order, 'items'>): boolean {
  return order.items.length > 0
}
