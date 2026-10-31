import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { IndexedDbOrderRepository } from '../services/orderRepository'
import { OrderService } from '../services/orderService'
import { createValidCartItem } from '../test/orderFixtures'
import type { TerminalConfiguration } from '../types/terminal'
import { buildOrderPrintJob, OrderPrintService } from './orderPrintService'
import { normalizeOrderPrinting } from './orderPrinting'
import type { ReceiptPrinter } from './types'

const terminal: TerminalConfiguration = {
  terminalId: 'witches-terminal',
  terminalCode: 'W',
  displayName: 'Caisse W',
  provisionedAt: '2026-10-30T10:00:00.000Z',
}

describe('impression Witches facultative', () => {
  it.each([false, true])(
    'enregistre une vente sans préparation, reçu demandé=%s',
    async (receipt) => {
      const repository = new IndexedDbOrderRepository(new IDBFactory(), 'witches-print-' + receipt)
      const service = new OrderService(
        repository,
        () => 'order-w',
        () => terminal,
      )
      const order = await service.createOrder(
        [createValidCartItem({ requiresPreparation: true })],
        'card',
        new Date('2026-10-30T12:00:00.000Z'),
        receipt,
      )
      expect(order.printing).toMatchObject({
        status: receipt ? 'pending' : 'printed',
        customerReceipt: receipt ? 'pending' : 'not_requested',
        preparationTicket: 'not_requested',
      })
      const printJob = vi.fn<ReceiptPrinter['printJob']>()
      const printer = new OrderPrintService({ printJob })
      await printer.printOrder(order)
      if (receipt) expect(printJob).toHaveBeenCalledOnce()
      else expect(printJob).not.toHaveBeenCalled()
      await repository.close()
    },
  )

  it('ne génère jamais de ticket de préparation, même pour une ancienne vente', () => {
    expect(
      buildOrderPrintJob(printPreviewOrder).documents.map((document) => document.type),
    ).toEqual(['customerReceipt'])
    expect(
      normalizeOrderPrinting(
        {
          ...printPreviewOrder.printing,
          customerReceipt: 'not_requested',
          preparationTicket: 'pending',
        },
        printPreviewOrder.createdAt,
      ),
    ).toMatchObject({
      status: 'printed',
      preparationTicket: 'not_requested',
    })
  })
})
