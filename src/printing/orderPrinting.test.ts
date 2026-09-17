import { describe, expect, it } from 'vitest'
import { derivePrintStatus, getRetryableDocuments, normalizeOrderPrinting } from './orderPrinting'

const updatedAt = '2026-09-01T18:15:00.000Z'

describe('état persistant des documents imprimés', () => {
  it('considère explicitement une commande sans document demandé comme terminée', () => {
    expect(
      derivePrintStatus({
        status: 'pending',
        pickupTicket: 'not_requested',
        customerReceipt: 'not_requested',
        preparationTicket: 'not_requested',
        attempts: 0,
        updatedAt,
      }),
    ).toBe('printed')
  })

  it('ignore les documents non demandés quand les documents requis sont imprimés', () => {
    expect(
      derivePrintStatus({
        status: 'pending',
        pickupTicket: 'printed',
        customerReceipt: 'not_requested',
        preparationTicket: 'printed',
        attempts: 1,
        updatedAt,
      }),
    ).toBe('printed')
  })

  it('normalise prudemment une ancienne commande sans état de bon de retrait', () => {
    const normalized = normalizeOrderPrinting(
      {
        status: 'printed',
        customerReceipt: 'printed',
        preparationTicket: 'printed',
        attempts: 1,
        updatedAt,
      },
      updatedAt,
    )

    expect(normalized).toMatchObject({
      status: 'unknown',
      pickupTicket: 'unknown',
      customerReceipt: 'printed',
      preparationTicket: 'printed',
    })
    expect(getRetryableDocuments(normalized)).toEqual([])
  })

  it('ne propose jamais automatiquement un document inconnu ou déjà imprimé', () => {
    expect(
      getRetryableDocuments({
        status: 'unknown',
        pickupTicket: 'unknown',
        customerReceipt: 'printed',
        preparationTicket: 'failed',
        attempts: 2,
        updatedAt,
      }),
    ).toEqual(['preparationTicket'])
  })
})
