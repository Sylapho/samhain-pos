import type { DataConfidence, VatRate } from './catalog'

export type SelectedVariant = {
  id: string
  name: string
  volume?: string
}

export type SelectedOption = {
  groupId: string
  groupName: string
  optionId: string
  optionName: string
  priceDeltaCents: number
}

export type CartItemDraft = {
  productId: string
  name: string
  unitPriceCents: number
  variant?: SelectedVariant
  options: SelectedOption[]
  dataConfidence: DataConfidence
  note?: string
  vatRate: VatRate
}

export type CartItem = CartItemDraft & {
  lineId: string
  quantity: number
}
