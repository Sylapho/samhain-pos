import type { CartItem } from '../types/cart'

export function createValidCartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    lineId: 'test-product::default',
    productId: 'test-product',
    name: 'Produit de test',
    unitPriceCents: 500,
    quantity: 1,
    options: [],
    ingredients: [],
    removedIngredientIds: [],
    dataConfidence: 'confirmed',
    vatRate: 10,
    ...overrides,
  }
}

export function createValidOrderItems(): CartItem[] {
  return [createValidCartItem()]
}
