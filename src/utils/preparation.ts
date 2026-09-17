import type { CartItem } from '../types/cart'
import type { Order } from '../types/order'

/** Legacy lines without a snapshot are treated conservatively as requiring preparation. */
export function itemRequiresPreparation(
  item: Pick<CartItem, 'requiresPreparation'> | Partial<Pick<CartItem, 'requiresPreparation'>>,
): boolean {
  return item.requiresPreparation !== false
}

export function getPreparationItems(order: Pick<Order, 'items'>): CartItem[] {
  return order.items.filter(itemRequiresPreparation)
}

export function orderRequiresPreparation(order: Pick<Order, 'items'>): boolean {
  return order.items.some(itemRequiresPreparation)
}
