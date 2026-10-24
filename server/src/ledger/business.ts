import type { ClientSession, Db } from 'mongodb'
import type { ChainScope, LedgerEvent, Sale } from '../persistence/model.ts'
import { parseStrictJson } from '../json.ts'
import { stable } from '../persistence/migrations.ts'
import { chainOf } from '../tablet-auth/guards.ts'
import {
  add,
  array,
  assert,
  date,
  fail,
  integer,
  keys,
  multiply,
  object,
  terminal,
  text,
  time,
} from './validation.ts'
import type { JsonObject } from './validation.ts'

export function validateOrder(value: unknown, sourceTerminal: string): JsonObject {
  const v = object(value)
  keys(
    v,
    [
      'id',
      'orderNumber',
      'receiptNumber',
      'paymentMethod',
      'paymentStatus',
      'paidAt',
      'items',
      'itemCount',
      'totalCents',
      'createdAt',
      'status',
    ],
    ['terminal', 'registerName'],
  )
  for (const key of ['id', 'orderNumber', 'receiptNumber']) text(v[key], true)
  assert(
    ['cash', 'card'].includes(text(v.paymentMethod)) &&
      v.paymentStatus === 'paid' &&
      v.status === 'confirmed',
  )
  date(v.paidAt)
  date(v.createdAt)
  if ('terminal' in v) assert(terminal(v.terminal).terminalId === sourceTerminal)
  else text(v.registerName)
  if ('registerName' in v) text(v.registerName)
  const items = array(v.items)
  assert(items.length > 0)
  let total = 0,
    count = 0
  const seen = new Set<string>()
  for (const item of items) {
    const line = object(item)
    keys(
      line,
      [
        'lineId',
        'productId',
        'name',
        'unitPriceCents',
        'quantity',
        'options',
        'ingredients',
        'removedIngredientIds',
        'dataConfidence',
        'vatRate',
      ],
      ['requiresPreparation', 'variant', 'note'],
    )
    const id = text(line.lineId, true)
    assert(!seen.has(id))
    seen.add(id)
    text(line.productId, true)
    text(line.name)
    assert(
      ['temporary', 'confirmed'].includes(text(line.dataConfidence)) &&
        [10, 20].includes(integer(line.vatRate)),
    )
    if ('requiresPreparation' in line)
      assert(typeof line.requiresPreparation === 'boolean', 'INVALID_PAYLOAD')
    if ('note' in line) text(line.note, false, true)
    if ('variant' in line) {
      const variant = object(line.variant)
      keys(variant, ['id', 'name'], ['volume'])
      text(variant.id, true)
      text(variant.name)
      if ('volume' in variant) text(variant.volume)
    }
    const quantity = integer(line.quantity, 1)
    total = add(total, multiply(quantity, integer(line.unitPriceCents, 0)))
    count = add(count, quantity)
    const options = new Set<string>(),
      ingredients = new Set<string>(),
      removed = new Set<string>()
    for (const value of array(line.options)) {
      const option = object(value)
      keys(option, ['groupId', 'groupName', 'optionId', 'optionName', 'priceDeltaCents'])
      const key = stable([text(option.groupId, true), text(option.optionId, true)])
      text(option.groupName)
      text(option.optionName)
      integer(option.priceDeltaCents)
      assert(!options.has(key))
      options.add(key)
    }
    for (const value of array(line.ingredients)) {
      const ingredient = object(value)
      keys(ingredient, ['id', 'name'])
      const key = text(ingredient.id, true)
      text(ingredient.name)
      assert(!ingredients.has(key))
      ingredients.add(key)
    }
    for (const value of array(line.removedIngredientIds)) {
      const key = text(value, true)
      assert(ingredients.has(key) && !removed.has(key))
      removed.add(key)
    }
  }
  assert(integer(v.totalCents, 0) === total && integer(v.itemCount, 1) === count)
  return v
}

// Structural checks run for the whole batch, including replays, before any financial write.
export function validatePayload(value: unknown): JsonObject {
  const p = object(value)
  const field = {
    sale: 'order',
    correction: 'correction',
    closure: 'closure',
    cash_session_opened: 'session',
    cash_float_updated: 'cashFloatUpdate',
  }[text(p.kind)]
  if (!field) fail()
  keys(p, [
    'schemaVersion',
    'id',
    'sequence',
    'kind',
    'recordedAt',
    'previousHash',
    'source',
    'hash',
    field,
    ...(p.kind === 'sale' ? ['orderId'] : []),
  ])
  text(p.id, true)
  integer(p.sequence, 1)
  date(p.recordedAt)
  const source = object(p.source)
  keys(source, ['softwareVersion', 'buildMode', 'terminal', 'organization'])
  text(source.softwareVersion)
  text(source.buildMode)
  const t = terminal(source.terminal)
  const org = object(source.organization)
  keys(org, [
    'organizationName',
    'eventName',
    'city',
    'address',
    'siret',
    'vatNumber',
    'usesDemoPlaceholders',
  ])
  for (const [key, value] of Object.entries(org)) {
    if (key === 'usesDemoPlaceholders') assert(typeof value === 'boolean', 'INVALID_PAYLOAD')
    else text(value, false, true)
  }
  const v = object(p[field])
  switch (p.kind) {
    case 'sale':
      validateOrder(v, text(t.terminalId, true))
      assert(text(p.orderId, true) === v.id)
      break
    case 'correction':
      keys(
        v,
        [
          'operationId',
          'originalOrderId',
          'originalOrderNumber',
          'originalReceiptNumber',
          'type',
          'reason',
          'amountDeltaCents',
          'paymentMethod',
          'originalSaleHash',
        ],
        ['refundLines'],
      )
      for (const key of [
        'operationId',
        'originalOrderId',
        'originalOrderNumber',
        'originalReceiptNumber',
      ])
        text(v[key], true)
      text(v.reason)
      assert(['cash', 'card'].includes(text(v.paymentMethod)))
      assert(
        v.originalSaleHash === null ||
          (typeof v.originalSaleHash === 'string' && /^[0-9a-f]{64}$/.test(v.originalSaleHash)),
      )
      assert(['cancellation', 'refund', 'adjustment'].includes(text(v.type)))
      assert(
        integer(v.amountDeltaCents) !== 0 &&
          (v.type === 'adjustment' || integer(v.amountDeltaCents) < 0),
      )
      if ('refundLines' in v) {
        assert(v.type === 'refund' && array(v.refundLines).length > 0)
        const seen = new Set<string>()
        for (const value of array(v.refundLines)) {
          const line = object(value)
          keys(line, [
            'originalLineId',
            'productId',
            'productName',
            'quantity',
            'unitPriceCents',
            'vatRate',
            'grossCents',
            'vatCents',
          ])
          const id = text(line.originalLineId, true)
          assert(!seen.has(id))
          seen.add(id)
          text(line.productId, true)
          text(line.productName)
          integer(line.quantity, 1)
          integer(line.unitPriceCents, 0)
          assert([10, 20].includes(integer(line.vatRate)))
          integer(line.grossCents, 0)
          integer(line.vatCents, 0)
        }
      }
      break
    case 'cash_session_opened':
      keys(v, ['sessionId', 'periodStart', 'openingFloatCents', 'createdAt'])
      text(v.sessionId, true)
      integer(v.openingFloatCents, 0)
      date(v.periodStart)
      date(v.createdAt)
      assert(v.createdAt === p.recordedAt && time(v.periodStart) <= time(v.createdAt))
      break
    case 'cash_float_updated':
      keys(v, [
        'operationId',
        'sessionId',
        'previousOpeningFloatCents',
        'newOpeningFloatCents',
        'updatedAt',
      ])
      text(v.operationId, true)
      text(v.sessionId, true)
      integer(v.previousOpeningFloatCents, 0)
      integer(v.newOpeningFloatCents, 0)
      date(v.updatedAt)
      assert(v.updatedAt === p.recordedAt)
      break
    case 'closure': {
      keys(
        v,
        ['operationId', 'periodStart', 'periodEnd', 'totals'],
        ['cashSessionId', 'openingFloatCents', 'theoreticalCashCents'],
      )
      text(v.operationId, true)
      date(v.periodStart)
      date(v.periodEnd)
      assert(time(v.periodStart) < time(v.periodEnd) && time(v.periodEnd) <= time(p.recordedAt))
      const totals = object(v.totals)
      keys(totals, [
        'saleCount',
        'grossSalesCents',
        'correctionCount',
        'correctionTotalCents',
        'netTotalCents',
        'cumulativeNetTotalCents',
        'paymentTotalsCents',
      ])
      for (const key of ['saleCount', 'grossSalesCents', 'correctionCount']) integer(totals[key], 0)
      for (const key of ['correctionTotalCents', 'netTotalCents', 'cumulativeNetTotalCents'])
        integer(totals[key])
      const payments = object(totals.paymentTotalsCents)
      keys(payments, ['cash', 'card'])
      integer(payments.cash)
      integer(payments.card)
      if ('cashSessionId' in v) {
        text(v.cashSessionId, true)
        integer(v.openingFloatCents, 0)
        integer(v.theoreticalCashCents)
      } else assert(!('openingFloatCents' in v) && !('theoreticalCashCents' in v))
      break
    }
  }
  return p
}

const payloadOf = (event: LedgerEvent) => object(parseStrictJson(event.payloadCanonical))

export async function validateBusiness(
  event: LedgerEvent,
  context: { db: Db; session: ClientSession; signal?: AbortSignal },
) {
  const { db, session, signal } = context
  signal?.throwIfAborted()
  const scope = chainOf(event),
    options = { session, ...(signal ? { signal } : {}) }
  const events = db.collection<LedgerEvent>('ledgerEvents')
  const p = payloadOf(event)
  const lastClosure = await events.findOne(
    { ...scope, kind: 'closure' },
    { ...options, sort: { sequence: -1 } },
  )
  const previousEnd = lastClosure ? object(payloadOf(lastClosure).closure).periodEnd : null
  const opened = await events.findOne(
    { ...scope, kind: 'cash_session_opened' },
    { ...options, sort: { sequence: -1 } },
  )
  const closed =
    opened &&
    (await events.findOne(
      { ...scope, kind: 'closure', referencedSessionId: opened.sessionId! },
      options,
    ))
  const active = opened && !closed ? object(payloadOf(opened).session) : null
  let opening = 0
  if (active) {
    const updated = await events.findOne(
      { ...scope, kind: 'cash_float_updated', referencedSessionId: text(active.sessionId) },
      { ...options, sort: { sequence: -1 } },
    )
    opening = integer(
      updated
        ? object(payloadOf(updated).cashFloatUpdate).newOpeningFloatCents
        : active.openingFloatCents,
      0,
    )
  }
  switch (event.kind) {
    case 'sale':
      assert(!previousEnd || time(object(p.order).paidAt) >= time(previousEnd))
      return
    case 'correction':
      assert(!previousEnd || time(p.recordedAt) >= time(previousEnd))
      return validateCorrection(db, scope, object(p.correction), session, signal)
    case 'cash_session_opened': {
      const v = object(p.session)
      assert(!active && (!previousEnd || time(v.periodStart) === time(previousEnd)))
      return
    }
    case 'cash_float_updated': {
      const v = object(p.cashFloatUpdate)
      if (!active) fail('DEPENDENCY_MISSING', 409)
      assert(
        v.sessionId === active.sessionId &&
          opened!.sourceTerminalId === event.sourceTerminalId &&
          integer(v.previousOpeningFloatCents, 0) === opening,
      )
      return
    }
    case 'closure': {
      const v = object(p.closure)
      assert(!previousEnd || time(v.periodStart) === time(previousEnd))
      const totals = {
        saleCount: 0,
        grossSalesCents: 0,
        correctionCount: 0,
        correctionTotalCents: 0,
        netTotalCents: 0,
        cumulativeNetTotalCents: 0,
        paymentTotalsCents: { cash: 0, card: 0 },
      }
      // Stream the authoritative prefix; never load an unbounded history into memory.
      for await (const previous of events
        .find({ ...scope, kind: { $in: ['sale', 'correction'] } }, options)
        .sort({ sequence: 1 })) {
        signal?.throwIfAborted()
        const prior = payloadOf(previous)
        const value = object(previous.kind === 'sale' ? prior.order : prior.correction)
        const timestamp = time(previous.kind === 'sale' ? value.paidAt : prior.recordedAt)
        if (timestamp >= time(v.periodEnd)) continue
        const amount = integer(previous.kind === 'sale' ? value.totalCents : value.amountDeltaCents)
        totals.cumulativeNetTotalCents = add(totals.cumulativeNetTotalCents, amount)
        if (timestamp < time(v.periodStart)) continue
        if (previous.kind === 'sale') {
          totals.saleCount = add(totals.saleCount, 1)
          totals.grossSalesCents = add(totals.grossSalesCents, amount)
        } else {
          totals.correctionCount = add(totals.correctionCount, 1)
          totals.correctionTotalCents = add(totals.correctionTotalCents, amount)
        }
        const method = value.paymentMethod
        assert(method === 'cash' || method === 'card')
        totals.paymentTotalsCents[method] = add(totals.paymentTotalsCents[method], amount)
      }
      totals.netTotalCents = add(totals.grossSalesCents, totals.correctionTotalCents)
      assert(stable(v.totals) === stable(totals))
      if ('cashSessionId' in v) {
        if (!active) fail('DEPENDENCY_MISSING', 409)
        assert(
          v.cashSessionId === active.sessionId &&
            opened!.sourceTerminalId === event.sourceTerminalId &&
            time(v.periodStart) === time(active.periodStart) &&
            v.openingFloatCents === opening &&
            v.theoreticalCashCents === add(opening, totals.paymentTotalsCents.cash),
        )
      }
      return
    }
  }
}

async function validateCorrection(
  db: Db,
  scope: ChainScope,
  v: JsonObject,
  session: ClientSession,
  signal?: AbortSignal,
) {
  const options = { session, ...(signal ? { signal } : {}) }
  const events = db.collection<LedgerEvent>('ledgerEvents')
  const sale = await db
    .collection<Sale>('sales')
    .findOne({ ...scope, orderId: text(v.originalOrderId) }, options)
  if (!sale) fail('DEPENDENCY_MISSING', 409)
  const originalEvent =
    sale.type === 'sealed'
      ? await events.findOne({ ...scope, eventId: sale.ledgerEventId }, options)
      : null
  if (sale.type === 'sealed' && !originalEvent) fail('DEPENDENCY_MISSING', 409)
  const original =
    sale.type === 'legacy'
      ? object(parseStrictJson(sale.payloadCanonical))
      : object(payloadOf(originalEvent!).order)
  assert(
    v.originalOrderNumber === original.orderNumber &&
      v.originalReceiptNumber === original.receiptNumber &&
      v.paymentMethod === original.paymentMethod &&
      v.originalSaleHash === (sale.type === 'sealed' ? sale.saleHash : null),
  )
  let count = 0,
    refundedAmount = 0,
    amountOnly = false
  const quantities = new Map<string, number>()
  for await (const event of events.find(
    { ...scope, kind: 'correction', originalOrderId: text(v.originalOrderId) },
    options,
  )) {
    signal?.throwIfAborted()
    const prior = object(payloadOf(event).correction)
    assert(prior.type !== 'cancellation')
    count++
    if (prior.type !== 'refund') continue
    refundedAmount = add(refundedAmount, -integer(prior.amountDeltaCents))
    if (!('refundLines' in prior)) amountOnly = true
    for (const value of array(prior.refundLines ?? [])) {
      const line = object(value),
        id = text(line.originalLineId)
      quantities.set(id, add(quantities.get(id) ?? 0, integer(line.quantity, 1)))
    }
  }
  const delta = integer(v.amountDeltaCents)
  if (v.type === 'cancellation') assert(delta === -integer(original.totalCents, 0) && count === 0)
  if (v.type !== 'refund') return
  assert(add(refundedAmount, -delta) <= integer(original.totalCents, 0))
  if (!('refundLines' in v)) return // Historical absence is financial evidence, not an empty array.
  assert(!amountOnly)
  let total = 0
  for (const value of array(v.refundLines)) {
    const line = object(value),
      id = text(line.originalLineId)
    const sold = array(original.items)
      .map(object)
      .find((item) => item.lineId === id)
    assert(sold)
    const quantity = integer(line.quantity, 1),
      previousQuantity = quantities.get(id) ?? 0
    assert(add(quantity, previousQuantity) <= integer(sold.quantity, 1))
    const unit = integer(sold.unitPriceCents, 0),
      rate = integer(sold.vatRate)
    const gross = multiply(unit, quantity),
      previousGross = multiply(unit, previousQuantity)
    // Frozen JS/Kotlin rounding on cumulative gross, as in saleRefund.ts; no catalog lookup.
    const vat = (amount: number) => integer(Math.round((amount * rate) / (100 + rate)), 0)
    const expected = {
      originalLineId: id,
      productId: sold.productId,
      productName: sold.name,
      quantity,
      unitPriceCents: unit,
      vatRate: rate,
      grossCents: gross,
      vatCents: vat(add(previousGross, gross)) - vat(previousGross),
    }
    assert(stable(line) === stable(expected))
    total = add(total, gross)
  }
  assert(delta === -total)
}
