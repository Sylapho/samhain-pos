export const productCategories = [
  'Menus',
  'Plats',
  'Sucré',
  'Boissons chaudes',
  'Bières',
  'Cidre',
  'Softs',
] as const

export type ProductCategory = (typeof productCategories)[number]
export type ProductAvailability = 'available' | 'sold-out'

export type Product = {
  id: string
  name: string
  category: ProductCategory
  priceCents: number
  availability: ProductAvailability
  priceIsMock?: boolean
  description?: string
  hasOptionsPrototype?: boolean
}
