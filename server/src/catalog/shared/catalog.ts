export type CategoryId = string

export type Category = {
  id: CategoryId
  label: string
  active: boolean
  displayOrder: number
}

export type ProductAvailability = 'available' | 'sold-out'
export type DataConfidence = 'confirmed' | 'temporary'
export type VatRate = 5.5 | 10 | 20

export type ProductVariant = {
  id: string
  name: string
  volume?: string | undefined
  priceCents: number
  dataConfidence?: DataConfidence
  note?: string
}

export type ProductOption = {
  id: string
  name: string
  priceDeltaCents?: number
  default?: boolean
}

export type ProductOptionGroup = {
  id: string
  name: string
  type: 'single' | 'multiple'
  required: boolean
  options: ProductOption[]
}

export type ProductIngredient = {
  id: string
  name: string
}

export type Product = {
  id: string
  name: string
  categoryId: CategoryId
  active: boolean
  displayOrder: number
  requiresPreparation: boolean
  availability: ProductAvailability
  // Derived presentation fields, never persisted or published. Availability is effective for sale.
  localAvailability?: ProductAvailability
  centralAvailability?: ProductAvailability
  priceCents?: number | undefined
  description?: string | undefined
  variants?: ProductVariant[] | undefined
  optionGroups?: ProductOptionGroup[] | undefined
  ingredients?: ProductIngredient[] | undefined
  dataConfidence?: DataConfidence
  note?: string
  vatRate: VatRate
}

export type ProductSelection = {
  variantId?: string
  optionIdsByGroup: Record<string, string[]>
}
