import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../../mocks/printOrder'
import type { PrintJobResult } from '../../printing/types'
import { resetMockOrderSequenceForTests } from '../../services/orderService'
import { CheckoutFlow } from './CheckoutFlow'

const success: PrintJobResult = {
  ok: true,
  bytesWritten: 100,
  completedDocuments: ['customerReceipt', 'preparationTicket'],
  warnings: [],
}

describe('encaissement et impression', () => {
  beforeEach(resetMockOrderSequenceForTests)

  it('attend la fin du job, bloque le double clic et réimprime la même commande', async () => {
    let finishFirstPrint: ((result: PrintJobResult) => void) | undefined
    const printOrder = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<PrintJobResult>((resolve) => (finishFirstPrint = resolve)),
      )
      .mockResolvedValue(success)

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))
    expect(screen.getByRole('button', { name: 'Impression en cours…' })).toBeDisabled()
    expect(printOrder).toHaveBeenCalledOnce()

    await act(async () => finishFirstPrint?.(success))
    expect(await screen.findByRole('heading', { name: 'Commande validée' })).toBeInTheDocument()
    expect(screen.getByText('A001')).toBeInTheDocument()
    expect(printOrder.mock.calls[0]?.[0].paymentMethod).toBe('cash')

    fireEvent.click(screen.getByRole('button', { name: 'Préparation' }))
    expect(printOrder).toHaveBeenCalledTimes(2)
    expect(printOrder.mock.calls[1]?.[0].receiptNumber).toBe(
      printOrder.mock.calls[0]?.[0].receiptNumber,
    )
    expect(printOrder.mock.calls[1]?.[1]).toMatchObject({ selection: 'preparation' })
  })
})
