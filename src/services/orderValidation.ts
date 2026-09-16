import type { CartItem, SelectedOption, SelectedVariant } from '../types/cart'
import type { CheckoutIntent, CheckoutIntentStatus } from '../types/checkout'
import type { DataConfidence, ProductIngredient, VatRate } from '../types/catalog'
import type { PaymentMethod, PaymentStatus } from '../types/order'
import type { LedgerSource } from '../types/salesLedger'
import {
  terminalCodes,
  type TerminalCode,
  type TerminalConfiguration,
  type TerminalIdentity,
} from '../types/terminal'
import { calculateCartTotals } from '../utils/cartTotals'

type UnknownRecord = Record<string, unknown>

export type OrderDraftValidationInput = {
  id: unknown
  terminal: unknown
  paymentMethod: unknown
  paymentStatus: unknown
  paidAt: unknown
  items: unknown
  itemCount?: unknown
  totalCents?: unknown
  createdAt: unknown
  status: unknown
}

export type ValidatedOrderDraft = {
  id: string
  terminal: TerminalIdentity
  paymentMethod: PaymentMethod
  paymentStatus: PaymentStatus
  paidAt: string
  items: CartItem[]
  itemCount: number
  totalCents: number
  createdAt: string
  status: 'confirmed'
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`)
  }
  return value as UnknownRecord
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} doit être un tableau.`)
  return value
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} doit être une chaîne non vide.`)
  }
  return value
}

function safeInteger(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} doit être un entier sûr.`)
  }
  if (minimum !== undefined && value < minimum) {
    throw new Error(`${label} doit être supérieur ou égal à ${minimum}.`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} doit être booléen.`)
  return value
}

function isTerminalCode(value: unknown): value is TerminalCode {
  return terminalCodes.some((code) => code === value)
}

function validateIsoTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} doit être un timestamp ISO valide.`)
  }
  return value
}

function validateVariant(value: unknown, lineId: string): SelectedVariant | undefined {
  if (value === undefined) return undefined
  const candidate = record(value, `La variante de la ligne « ${lineId} »`)
  const variant: SelectedVariant = {
    id: nonBlankString(candidate.id, `L’identifiant de variante de la ligne « ${lineId} »`),
    name: nonBlankString(candidate.name, `Le nom de variante de la ligne « ${lineId} »`),
  }
  if (candidate.volume !== undefined) {
    variant.volume = nonBlankString(candidate.volume, `Le volume de la ligne « ${lineId} »`)
  }
  return variant
}

function validateOptions(value: unknown, lineId: string): SelectedOption[] {
  const options = array(value, `Les options de la ligne « ${lineId} »`)
  const seen = new Set<string>()
  return options.map((option, index) => {
    const candidate = record(option, `L’option ${index + 1} de la ligne « ${lineId} »`)
    const validated: SelectedOption = {
      groupId: nonBlankString(candidate.groupId, `Le groupe de l’option ${index + 1}`),
      groupName: nonBlankString(candidate.groupName, `Le nom du groupe de l’option ${index + 1}`),
      optionId: nonBlankString(candidate.optionId, `L’identifiant de l’option ${index + 1}`),
      optionName: nonBlankString(candidate.optionName, `Le nom de l’option ${index + 1}`),
      priceDeltaCents: safeInteger(
        candidate.priceDeltaCents,
        `Le supplément de l’option ${index + 1}`,
      ),
    }
    const key = `${validated.groupId}\u0000${validated.optionId}`
    if (seen.has(key)) {
      throw new Error(
        `L’option « ${validated.optionName} » est dupliquée sur la ligne « ${lineId} ».`,
      )
    }
    seen.add(key)
    return validated
  })
}

function validateIngredients(value: unknown, lineId: string): ProductIngredient[] {
  const ingredients = array(value, `Les ingrédients de la ligne « ${lineId} »`)
  const seen = new Set<string>()
  return ingredients.map((ingredient, index) => {
    const candidate = record(ingredient, `L’ingrédient ${index + 1} de la ligne « ${lineId} »`)
    const validated = {
      id: nonBlankString(candidate.id, `L’identifiant de l’ingrédient ${index + 1}`),
      name: nonBlankString(candidate.name, `Le nom de l’ingrédient ${index + 1}`),
    }
    if (seen.has(validated.id)) {
      throw new Error(`L’ingrédient « ${validated.id} » est dupliqué sur la ligne « ${lineId} ».`)
    }
    seen.add(validated.id)
    return validated
  })
}

function validateRemovedIngredientIds(
  value: unknown,
  ingredients: ProductIngredient[],
  lineId: string,
): string[] {
  const removed = array(value, `Les ingrédients retirés de la ligne « ${lineId} »`).map(
    (ingredientId, index) =>
      nonBlankString(ingredientId, `L’ingrédient retiré ${index + 1} de la ligne « ${lineId} »`),
  )
  if (new Set(removed).size !== removed.length) {
    throw new Error(`Un ingrédient retiré est dupliqué sur la ligne « ${lineId} ».`)
  }
  const available = new Set(ingredients.map((ingredient) => ingredient.id))
  const unknownIngredient = removed.find((ingredientId) => !available.has(ingredientId))
  if (unknownIngredient) {
    throw new Error(
      `L’ingrédient retiré « ${unknownIngredient} » n’existe pas dans la ligne « ${lineId} ».`,
    )
  }
  return removed
}

function validateCartItem(value: unknown, index: number): CartItem {
  const candidate = record(value, `La ligne ${index + 1}`)
  const lineId = nonBlankString(candidate.lineId, `L’identifiant de la ligne ${index + 1}`)
  const quantity = safeInteger(candidate.quantity, `La quantité de la ligne « ${lineId} »`, 1)
  const unitPriceCents = safeInteger(
    candidate.unitPriceCents,
    `Le prix unitaire de la ligne « ${lineId} »`,
    0,
  )
  if (candidate.vatRate !== 10 && candidate.vatRate !== 20) {
    throw new Error(`Le taux de TVA ${String(candidate.vatRate)} n’est pas supporté.`)
  }
  if (candidate.dataConfidence !== 'confirmed' && candidate.dataConfidence !== 'temporary') {
    throw new Error(`Le niveau de confiance de la ligne « ${lineId} » est invalide.`)
  }

  const ingredients = validateIngredients(candidate.ingredients, lineId)
  const item: CartItem = {
    lineId,
    productId: nonBlankString(
      candidate.productId,
      `L’identifiant produit de la ligne « ${lineId} »`,
    ),
    name: nonBlankString(candidate.name, `Le nom produit de la ligne « ${lineId} »`),
    unitPriceCents,
    quantity,
    options: validateOptions(candidate.options, lineId),
    ingredients,
    removedIngredientIds: validateRemovedIngredientIds(
      candidate.removedIngredientIds,
      ingredients,
      lineId,
    ),
    dataConfidence: candidate.dataConfidence as DataConfidence,
    vatRate: candidate.vatRate as VatRate,
  }
  const variant = validateVariant(candidate.variant, lineId)
  if (variant) item.variant = variant
  if (candidate.note !== undefined) {
    if (typeof candidate.note !== 'string') {
      throw new Error(`La note de la ligne « ${lineId} » doit être une chaîne.`)
    }
    item.note = candidate.note
  }
  return item
}

export function validateTerminalIdentity(value: unknown): TerminalIdentity {
  const candidate = record(value, 'Le terminal')
  const terminalCode = candidate.terminalCode
  if (!isTerminalCode(terminalCode)) {
    throw new Error(`Le code terminal « ${String(terminalCode)} » n’est pas supporté.`)
  }
  return {
    terminalId: nonBlankString(candidate.terminalId, 'L’identifiant du terminal'),
    terminalCode,
    displayName: nonBlankString(candidate.displayName, 'Le nom visible du terminal'),
  }
}

export function validateTerminalConfiguration(value: unknown): TerminalConfiguration {
  const candidate = record(value, 'La configuration du terminal')
  return {
    ...validateTerminalIdentity(candidate),
    provisionedAt: validateIsoTimestamp(candidate.provisionedAt, 'La date de provisioning'),
  }
}

export function toIsoTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} doit être une date valide.`)
  }
  return value.toISOString()
}

export function validateOrderDraft(draft: OrderDraftValidationInput): ValidatedOrderDraft {
  const id = nonBlankString(draft.id, 'L’identifiant de la commande')
  const terminal = validateTerminalIdentity(draft.terminal)
  if (draft.paymentMethod !== 'cash' && draft.paymentMethod !== 'card') {
    throw new Error(`Le moyen de paiement « ${String(draft.paymentMethod)} » n’est pas supporté.`)
  }
  if (draft.paymentStatus !== 'paid') throw new Error('L’état de paiement doit être « paid ».')
  if (draft.status !== 'confirmed')
    throw new Error('L’état de la commande doit être « confirmed ».')

  const rawItems = array(draft.items, 'Les lignes de la commande')
  if (rawItems.length === 0) throw new Error('La commande doit contenir au moins une ligne.')
  const items = rawItems.map(validateCartItem)
  const seenLineIds = new Set<string>()
  for (const item of items) {
    if (seenLineIds.has(item.lineId)) {
      throw new Error(`L’identifiant de ligne « ${item.lineId} » est dupliqué.`)
    }
    seenLineIds.add(item.lineId)
  }

  const { itemCount, totalCents } = calculateCartTotals(items)
  if (itemCount <= 0) throw new Error('Le nombre total d’articles doit être strictement positif.')
  if (draft.itemCount !== undefined) {
    const suppliedItemCount = safeInteger(draft.itemCount, 'Le nombre total d’articles', 1)
    if (suppliedItemCount !== itemCount) {
      throw new Error('Le nombre total d’articles ne correspond pas aux lignes.')
    }
  }
  if (draft.totalCents !== undefined) {
    const suppliedTotalCents = safeInteger(draft.totalCents, 'Le total de la commande', 0)
    if (suppliedTotalCents !== totalCents) {
      throw new Error('Le total de la commande ne correspond pas aux lignes.')
    }
  }

  return {
    id,
    terminal,
    paymentMethod: draft.paymentMethod,
    paymentStatus: 'paid',
    paidAt: validateIsoTimestamp(draft.paidAt, 'La date de paiement'),
    items,
    itemCount,
    totalCents,
    createdAt: validateIsoTimestamp(draft.createdAt, 'La date de création'),
    status: 'confirmed',
  }
}

const checkoutIntentStatuses = [
  'pending_payment',
  'payment_to_verify',
  'payment_confirmed',
  'finalized',
  'abandoned',
] as const satisfies readonly CheckoutIntentStatus[]

function validateLedgerSource(value: unknown, terminal: TerminalIdentity): LedgerSource {
  const source = record(value, 'La source du journal')
  const sourceTerminal = validateTerminalIdentity(source.terminal)
  if (
    sourceTerminal.terminalId !== terminal.terminalId ||
    sourceTerminal.terminalCode !== terminal.terminalCode
  ) {
    throw new Error("La source du journal ne correspond pas au terminal de l'encaissement.")
  }
  nonBlankString(source.softwareVersion, 'La version logicielle')
  nonBlankString(source.buildMode, 'Le mode de compilation')
  record(source.organization, "L'organisation du journal")
  return structuredClone(value) as LedgerSource
}

export function validateCheckoutIntent(value: unknown): CheckoutIntent {
  const candidate = record(value, "L'intention d'encaissement")
  const id = nonBlankString(candidate.id, "L'identifiant de l'encaissement")
  const terminal = validateTerminalIdentity(candidate.terminal)
  const createdAt = validateIsoTimestamp(candidate.createdAt, 'La date de création')
  const updatedAt = validateIsoTimestamp(candidate.updatedAt, 'La date de mise à jour')
  const status = candidate.status
  if (!checkoutIntentStatuses.some((allowed) => allowed === status)) {
    throw new Error(`L’état d’encaissement « ${String(status)} » est invalide.`)
  }
  const validatedOrder = validateOrderDraft({
    id,
    terminal,
    paymentMethod: candidate.paymentMethod,
    paymentStatus: 'paid',
    paidAt: candidate.paymentConfirmedAt ?? createdAt,
    items: candidate.cartSnapshot,
    itemCount: candidate.itemCount,
    totalCents: candidate.totalCents,
    createdAt,
    status: 'confirmed',
  })
  const intent: CheckoutIntent = {
    id,
    cartSnapshot: validatedOrder.items,
    itemCount: validatedOrder.itemCount,
    totalCents: validatedOrder.totalCents,
    paymentMethod: validatedOrder.paymentMethod,
    status: status as CheckoutIntentStatus,
    terminal,
    ledgerSource: validateLedgerSource(candidate.ledgerSource, terminal),
    orderNumberPrefix: nonBlankString(candidate.orderNumberPrefix, 'Le préfixe de commande'),
    receiptNumberPrefix: nonBlankString(candidate.receiptNumberPrefix, 'Le préfixe de reçu'),
    printCustomerReceipt: boolean(
      candidate.printCustomerReceipt,
      "Le choix d'impression du ticket client",
    ),
    createdAt,
    updatedAt,
  }
  if (intent.orderNumberPrefix !== terminal.terminalCode) {
    throw new Error('Le préfixe de commande ne correspond pas au terminal.')
  }
  if (!intent.receiptNumberPrefix.startsWith(`R-${terminal.terminalCode}-`)) {
    throw new Error('Le préfixe de reçu ne correspond pas au terminal.')
  }

  if (candidate.paymentConfirmedAt !== undefined) {
    intent.paymentConfirmedAt = validateIsoTimestamp(
      candidate.paymentConfirmedAt,
      'La date de confirmation du paiement',
    )
  }
  if (candidate.finalizedOrderId !== undefined) {
    intent.finalizedOrderId = nonBlankString(
      candidate.finalizedOrderId,
      "L'identifiant de la vente finalisée",
    )
  }
  if (candidate.abandonedAt !== undefined) {
    intent.abandonedAt = validateIsoTimestamp(candidate.abandonedAt, "La date d'abandon")
  }

  if (status === 'payment_confirmed' && !intent.paymentConfirmedAt) {
    throw new Error('Un paiement confirmé doit conserver sa date de confirmation.')
  }
  if (status === 'finalized' && (!intent.paymentConfirmedAt || !intent.finalizedOrderId)) {
    throw new Error('Un encaissement finalisé doit référencer sa vente et son paiement.')
  }
  if (status === 'abandoned' && !intent.abandonedAt) {
    throw new Error("Un encaissement abandonné doit conserver sa date d'abandon.")
  }
  return intent
}
