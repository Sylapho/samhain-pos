export type CartLineAmounts = {
  lineId?: string
  quantity: number
  unitPriceCents: number
}

export type CartTotals = {
  itemCount: number
  totalCents: number
}

const MAX_PERSISTED_ITEM_COUNT = 2_147_483_647

export function calculateCartTotals(items: readonly CartLineAmounts[]): CartTotals {
  let itemCount = 0
  let totalCents = 0

  for (const item of items) {
    const lineLabel = item.lineId?.trim() ? ` « ${item.lineId} »` : ''
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(
        `La quantité de la ligne${lineLabel} doit être un entier sûr strictement positif.`,
      )
    }
    if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new Error(
        `Le prix unitaire de la ligne${lineLabel} doit être un entier sûr positif ou nul.`,
      )
    }

    const lineTotalCents = item.unitPriceCents * item.quantity
    if (!Number.isSafeInteger(lineTotalCents)) {
      throw new Error(`Le total de la ligne${lineLabel} dépasse la plage entière sûre.`)
    }

    itemCount += item.quantity
    totalCents += lineTotalCents
    if (!Number.isSafeInteger(itemCount) || itemCount > MAX_PERSISTED_ITEM_COUNT) {
      throw new Error('Le nombre total d’articles dépasse la plage persistable.')
    }
    if (!Number.isSafeInteger(totalCents)) {
      throw new Error('Le total de la commande dépasse la plage entière sûre.')
    }
  }

  return { itemCount, totalCents }
}
