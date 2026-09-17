import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createValidCartItem, createValidOrderItems } from '../test/orderFixtures'
import type { PaymentMethod } from '../types/order'
import type { TerminalConfiguration } from '../types/terminal'
import { createLedgerSource } from './ledgerSource'
import { IndexedDbOrderRepository, type OrderCreationRequest } from './orderRepository'
import { OrderService } from './orderService'
import { validateOrderDraft } from './orderValidation'

const terminal: TerminalConfiguration = {
  terminalId: 'terminal-a',
  terminalCode: 'A',
  displayName: 'Caisse A',
  provisionedAt: '2026-08-01T10:00:00.000Z',
}

function validDraft(overrides: Partial<Parameters<typeof validateOrderDraft>[0]> = {}) {
  return {
    id: 'order-1',
    terminal,
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paidAt: '2026-09-01T12:00:00.000Z',
    items: createValidOrderItems(),
    createdAt: '2026-09-01T12:00:00.000Z',
    status: 'confirmed',
    ...overrides,
  }
}

function validRequest(overrides: Partial<OrderCreationRequest> = {}): OrderCreationRequest {
  return {
    id: 'order-1',
    terminal,
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paidAt: '2026-09-01T12:00:00.000Z',
    items: createValidOrderItems(),
    createdAt: '2026-09-01T12:00:00.000Z',
    status: 'confirmed',
    orderNumberPrefix: 'A',
    receiptNumberPrefix: 'R-A-20260901',
    itemCount: 1,
    totalCents: 500,
    printing: {
      status: 'pending',
      pickupTicket: 'pending',
      customerReceipt: 'pending',
      preparationTicket: 'pending',
      attempts: 0,
      updatedAt: '2026-09-01T12:00:00.000Z',
    },
    ...overrides,
  }
}

describe('validation métier des nouvelles commandes', () => {
  it('normalise prudemment une ancienne ligne sans snapshot de préparation', () => {
    const legacyItem = createValidCartItem() as Partial<ReturnType<typeof createValidCartItem>>
    delete legacyItem.requiresPreparation

    expect(
      validateOrderDraft(validDraft({ items: [legacyItem] })).items[0]?.requiresPreparation,
    ).toBe(true)
  })

  it('refuse une valeur de préparation non booléenne', () => {
    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [{ ...createValidCartItem(), requiresPreparation: 'non' }],
        }),
      ),
    ).toThrow(/besoin de préparation.*booléen/)
  })

  it('refuse une commande vide avant persistance sans consommer de séquence', async () => {
    const repository = new IndexedDbOrderRepository(new IDBFactory(), 'reject-empty-order')
    const service = new OrderService(
      repository,
      () => 'rejected-order',
      () => terminal,
    )

    expect(() => service.createOrder([], 'cash')).toThrow(/au moins une ligne/)
    expect(() => service.createOrder(createValidOrderItems(), 'bitcoin' as PaymentMethod)).toThrow(
      /moyen de paiement.*pas supporté/,
    )
    expect(await service.getOrders()).toEqual([])

    const accepted = new OrderService(
      repository,
      () => 'accepted-order',
      () => terminal,
    )
    expect((await accepted.createOrder(createValidOrderItems(), 'cash')).orderNumber).toBe('A-0001')
    expect(await repository.getLedgerEntries()).toHaveLength(1)
    await repository.close()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuse la quantité invalide %s',
    (quantity) => {
      expect(() =>
        validateOrderDraft(validDraft({ items: [createValidCartItem({ quantity })] })),
      ).toThrow(/quantité/)
    },
  )

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuse le prix invalide %s',
    (unitPriceCents) => {
      expect(() =>
        validateOrderDraft(validDraft({ items: [createValidCartItem({ unitPriceCents })] })),
      ).toThrow(/prix unitaire/)
    },
  )

  it('refuse les dépassements lors de la multiplication et de la somme', () => {
    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [createValidCartItem({ unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2 })],
        }),
      ),
    ).toThrow(/total de la ligne.*plage entière sûre/)

    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [
            createValidCartItem({ lineId: 'first', unitPriceCents: Number.MAX_SAFE_INTEGER }),
            createValidCartItem({ lineId: 'second', unitPriceCents: 1 }),
          ],
        }),
      ),
    ).toThrow(/total de la commande.*plage entière sûre/)

    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [createValidCartItem({ quantity: 2_147_483_648, unitPriceCents: 0 })],
        }),
      ),
    ).toThrow(/nombre total d’articles.*plage persistable/)
  })

  it.each(['', '   '])('refuse le nom produit vide %#', (name) => {
    expect(() =>
      validateOrderDraft(validDraft({ items: [createValidCartItem({ name })] })),
    ).toThrow(/nom produit/)
  })

  it('refuse les identifiants de ligne vides ou dupliqués', () => {
    expect(() =>
      validateOrderDraft(validDraft({ items: [createValidCartItem({ lineId: '   ' })] })),
    ).toThrow(/identifiant de la ligne/)
    expect(() =>
      validateOrderDraft(validDraft({ items: [createValidCartItem(), createValidCartItem()] })),
    ).toThrow(/identifiant de ligne.*dupliqué/)
  })

  it.each([10, 20])('accepte le taux de TVA %s', (vatRate) => {
    expect(
      validateOrderDraft(
        validDraft({ items: [createValidCartItem({ vatRate: vatRate as 10 | 20 })] }),
      ).items[0]?.vatRate,
    ).toBe(vatRate)
  })

  it.each([0, 5.5, 5, 21])('refuse le taux de TVA inconnu %s', (vatRate) => {
    expect(() =>
      validateOrderDraft(validDraft({ items: [createValidCartItem({ vatRate: vatRate as 10 })] })),
    ).toThrow(/TVA.*pas supporté/)
  })

  it.each(['bitcoin', 'unknown'])('refuse le moyen de paiement %s', (paymentMethod) => {
    expect(() =>
      validateOrderDraft(validDraft({ paymentMethod: paymentMethod as PaymentMethod })),
    ).toThrow(/moyen de paiement.*pas supporté/)
  })

  it('refuse les dates invalides et les identifiants vides', () => {
    expect(() => validateOrderDraft(validDraft({ createdAt: 'date-invalide' }))).toThrow(
      /timestamp ISO valide/,
    )
    expect(() => validateOrderDraft(validDraft({ id: '   ' }))).toThrow(
      /identifiant de la commande/,
    )
  })

  it('refuse un terminal incomplet ou portant un code inconnu', () => {
    expect(() =>
      validateOrderDraft(validDraft({ terminal: { ...terminal, terminalId: ' ' } })),
    ).toThrow(/identifiant du terminal/)
    expect(() =>
      validateOrderDraft(validDraft({ terminal: { ...terminal, terminalCode: 'Z' } })),
    ).toThrow(/code terminal/)
  })

  it('valide la cohérence des variantes, options et ingrédients retirés', () => {
    expect(() =>
      validateOrderDraft(
        validDraft({ items: [createValidCartItem({ variant: { id: '', name: 'Taille' } })] }),
      ),
    ).toThrow(/identifiant de variante/)
    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [
            createValidCartItem({
              options: [
                {
                  groupId: 'sauce',
                  groupName: 'Sauce',
                  optionId: 'ketchup',
                  optionName: 'Ketchup',
                  priceDeltaCents: 0,
                },
                {
                  groupId: 'sauce',
                  groupName: 'Sauce',
                  optionId: 'ketchup',
                  optionName: 'Ketchup',
                  priceDeltaCents: 0,
                },
              ],
            }),
          ],
        }),
      ),
    ).toThrow(/option.*dupliquée/)
    expect(() =>
      validateOrderDraft(
        validDraft({
          items: [
            createValidCartItem({
              ingredients: [{ id: 'pain', name: 'Pain' }],
              removedIngredientIds: ['fromage'],
            }),
          ],
        }),
      ),
    ).toThrow(/n’existe pas/)
  })

  it('recalcule les totaux et refuse les valeurs transportées falsifiées au repository', async () => {
    const repository = new IndexedDbOrderRepository(new IDBFactory(), 'forged-totals')
    expect(() =>
      repository.createOrder(validRequest({ itemCount: 2 }), createLedgerSource(terminal)),
    ).toThrow(/nombre total d’articles ne correspond pas/)
    expect(() =>
      repository.createOrder(validRequest({ totalCents: 1 }), createLedgerSource(terminal)),
    ).toThrow(/total de la commande ne correspond pas/)
    expect(await repository.getOrders()).toEqual([])
    await repository.close()
  })

  it('refuse un Invalid Date dans OrderService avant le repository', () => {
    const repository = new IndexedDbOrderRepository(new IDBFactory(), 'invalid-date')
    const service = new OrderService(
      repository,
      () => 'order-1',
      () => terminal,
    )
    expect(() => service.createOrder(createValidOrderItems(), 'card', new Date('invalid'))).toThrow(
      /date de création.*valide/,
    )
  })
})
