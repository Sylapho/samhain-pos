import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../../mocks/printOrder'
import type { PrintJobResult } from '../../printing/types'
import { CheckoutFlow } from './CheckoutFlow'

const success: PrintJobResult = {
  ok: true,
  bytesWritten: 100,
  completedDocuments: ['customerReceipt', 'preparationTicket'],
  warnings: [],
}

describe('encaissement et impression', () => {
  it('persiste avant impression, bloque le double clic et réimprime la même commande', async () => {
    let finishPersistence: (() => void) | undefined
    let finishFirstPrint: ((result: PrintJobResult) => void) | undefined
    const createOrder = vi.fn(
      (_items, paymentMethod) =>
        new Promise<typeof printPreviewOrder>((resolve) => {
          finishPersistence = () => resolve({ ...printPreviewOrder, paymentMethod })
        }),
    )
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
        createOrder={createOrder}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    const checkout = screen.getByRole('button', { name: 'Encaisser et imprimer' })
    fireEvent.click(checkout)
    fireEvent.click(checkout)
    expect(screen.getByRole('button', { name: 'Impression en cours…' })).toBeDisabled()
    expect(printOrder).not.toHaveBeenCalled()
    expect(createOrder).toHaveBeenCalledOnce()

    await act(async () => finishPersistence?.())
    await waitFor(() => expect(printOrder).toHaveBeenCalledOnce())

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
    expect(createOrder).toHaveBeenCalledOnce()
  })

  it('n’imprime rien et autorise un nouvel essai si la persistance échoue', async () => {
    const createOrder = vi.fn().mockRejectedValue(new Error('IndexedDB indisponible'))
    const printOrder = vi.fn()

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
      />,
    )

    const checkout = screen.getByRole('button', { name: 'Encaisser et imprimer' })
    fireEvent.click(checkout)
    fireEvent.click(checkout)

    expect(
      await screen.findByText(
        'La commande n’a pas été enregistrée. Aucun ticket n’a été imprimé. Réessayez.',
      ),
    ).toBeInTheDocument()
    expect(createOrder).toHaveBeenCalledOnce()
    expect(printOrder).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeEnabled()
  })

  it('réutilise la commande persistée lorsque l’impression est relancée', async () => {
    const createOrder = vi.fn().mockResolvedValue(printPreviewOrder)
    const printOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error('Imprimante déconnectée. Vérifiez le câble puis réessayez.'))
      .mockResolvedValue(success)

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))
    expect(
      await screen.findByText(
        'Commande A001 enregistrée. Imprimante déconnectée. Vérifiez le câble puis réessayez.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Commande A001 · reçu R-20260901-0001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retour' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Réessayer l’impression' }))
    expect(await screen.findByRole('heading', { name: 'Commande validée' })).toBeInTheDocument()
    expect(createOrder).toHaveBeenCalledOnce()
    expect(printOrder).toHaveBeenCalledTimes(2)
  })
})
