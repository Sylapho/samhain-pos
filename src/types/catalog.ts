export const categoryIds = [
  'menus',
  'assiettes',
  'desserts',
  'boissons-chaudes',
  'bieres',
  'sans-alcool',
] as const

export type CategoryId = (typeof categoryIds)[number]

export type Category = {
  id: CategoryId
  label: string
}

export const productCategories: Category[] = [
  { id: 'menus', label: 'Menus' },
  { id: 'assiettes', label: 'Assiettes' },
  { id: 'desserts', label: 'Desserts' },
  { id: 'boissons-chaudes', label: 'Boissons chaudes' },
  { id: 'bieres', label: 'Bières' },
  { id: 'sans-alcool', label: 'Sans alcool' },
]

export type ProductAvailability = 'available' | 'sold-out'
export type DataConfidence = 'confirmed' | 'temporary'
export type VatRate = 10 | 20

export type ProductVariant = {
  id: string
  name: string
  volume?: string
  priceCents: number
  dataConfidence?: DataConfidence
  note?: string
}

export type ProductOption = {
  id: string
  name: string
  priceDeltaCents?: number
}

export type ProductOptionGroup = {
  id: string
  name: string
  required: boolean
  options: ProductOption[]
}

export type Product = {
  id: string
  name: string
  categoryId: CategoryId
  availability: ProductAvailability
  priceCents?: number
  description?: string
  variants?: ProductVariant[]
  optionGroups?: ProductOptionGroup[]
  dataConfidence?: DataConfidence
  note?: string
  vatRate: VatRate
}

export type ProductSelection = {
  variantId?: string
  optionIds: Record<string, string>
}
