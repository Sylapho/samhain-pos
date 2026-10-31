import { fireEvent, render, screen } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { OrderPrintService } from '../../printing/orderPrintService'
import type { ReceiptPrinter } from '../../printing/types'
import { CheckoutService } from '../../services/checkoutService'
import { IndexedDbOrderRepository } from '../../services/orderRepository'
import { OrderService } from '../../services/orderService'
import { createValidCartItem } from '../../test/orderFixtures'
import type { TerminalConfiguration } from '../../types/terminal'
import { CheckoutFlow } from './CheckoutFlow'

const terminal: TerminalConfiguration = {
  terminalId: 'witches-terminal',
  terminalCode: 'W',
  displayName: 'Caisse W',
  provisionedAt: '2026-10-30T10:00:00.000Z',
}

describe('encaissement Witches sans préparation', () => {
  it.each([false, true])('finalise avec reçu demandé=%s', async (receipt) => {
    const repository = new IndexedDbOrderRepository(new IDBFactory(), 'witches-checkout-' + receipt)
    const lifecycle = new OrderService(repository, undefined, () => terminal)
    const checkout = new CheckoutService(repository, undefined, () => terminal)
    const printJob = vi.fn<ReceiptPrinter['printJob']>(async (steps) => ({
      ok: true,
      bytesWritten: 100,
      completedDocuments: steps
        .filter((step) => step.type === 'document')
        .map((step) => step.documentType),
      warnings: [],
    }))
    const printer = new OrderPrintService({ printJob })
    render(
      <CheckoutFlow
        items={[createValidCartItem({ requiresPreparation: true })]}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        checkout={checkout}
        lifecycle={lifecycle}
        printOrder={printer.printOrder.bind(printer)}
      />,
    )
    if (receipt)
      fireEvent.click(screen.getByRole('checkbox', { name: 'Imprimer le ticket de caisse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Préparer le paiement TPE' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Paiement TPE accepté' }))
    await screen.findByRole('heading', { name: 'Commande validée' })
    const orders = await lifecycle.getOrders()
    expect(orders).toHaveLength(1)
    expect(orders[0]?.printing).toMatchObject({
      status: 'printed',
      preparationTicket: 'not_requested',
      customerReceipt: receipt ? 'printed' : 'not_requested',
    })
    if (receipt) {
      expect(printJob).toHaveBeenCalledOnce()
      expect(
        printJob.mock.calls[0]?.[0]
          .filter((step) => step.type === 'document')
          .map((step) => step.documentType),
      ).toEqual(['customerReceipt'])
    } else {
      expect(printJob).not.toHaveBeenCalled()
    }
    await repository.close()
  })
})
