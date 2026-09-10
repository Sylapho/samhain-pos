import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../../mocks/printOrder'
import { OrderPrintError, type PrintJobResult } from '../../printing/types'
import { CheckoutFlow } from './CheckoutFlow'

const success: PrintJobResult = {
  ok: true,
  bytesWritten: 100,
  completedDocuments: ['customerReceipt', 'preparationTicket'],
  warnings: [],
}

function createLifecycle(initialOrder = printPreviewOrder) {
  let current = structuredClone(initialOrder)
  return {
    beginPrinting: vi.fn(async () => {
      current = {
        ...current,
        printing: {
          ...current.printing,
          status: 'pending',
          attempts: current.printing.attempts + 1,
        },
      }
      return current
    }),
    completePrinting: vi.fn(async (_id, _selection, completedDocuments) => {
      current = {
        ...current,
        printing: {
          ...current.printing,
          status: 'printed',
          customerReceipt: completedDocuments.includes('customerReceipt')
            ? 'printed'
            : current.printing.customerReceipt,
          preparationTicket: completedDocuments.includes('preparationTicket')
            ? 'printed'
            : current.printing.preparationTicket,
        },
      }
      return current
    }),
    failPrinting: vi.fn(async (_id, _selection, completedDocuments, message) => {
      current = {
        ...current,
        printing: {
          ...current.printing,
          status: completedDocuments.length ? 'partial' : 'failed',
          customerReceipt: completedDocuments.includes('customerReceipt') ? 'printed' : 'failed',
          preparationTicket: completedDocuments.includes('preparationTicket')
            ? 'printed'
            : 'failed',
          lastError: message,
        },
      }
      return current
    }),
  }
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
    const lifecycle = createLifecycle({ ...printPreviewOrder, paymentMethod: 'cash' })

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
        lifecycle={lifecycle}
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
    expect(lifecycle.beginPrinting).toHaveBeenCalledOnce()

    await act(async () => finishFirstPrint?.(success))
    expect(await screen.findByRole('heading', { name: 'Commande validée' })).toBeInTheDocument()
    expect(lifecycle.completePrinting).toHaveBeenCalledOnce()
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
    const lifecycle = createLifecycle()

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
        lifecycle={lifecycle}
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
    expect(lifecycle.beginPrinting).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeEnabled()
  })

  it('ne lance pas l’imprimante si l’état de reprise ne peut pas être sauvegardé', async () => {
    const createOrder = vi.fn().mockResolvedValue(printPreviewOrder)
    const printOrder = vi.fn()
    const lifecycle = createLifecycle()
    lifecycle.beginPrinting.mockRejectedValueOnce(new Error('Écriture impossible'))

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
        lifecycle={lifecycle}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))

    expect(
      await screen.findByText(
        'Commande A001 enregistrée. Aucun ticket n’a été lancé car l’état de reprise n’a pas pu être sauvegardé.',
      ),
    ).toBeInTheDocument()
    expect(printOrder).not.toHaveBeenCalled()
    expect(lifecycle.failPrinting).not.toHaveBeenCalled()
  })

  it('réutilise la commande persistée lorsque l’impression est relancée', async () => {
    const createOrder = vi.fn().mockResolvedValue(printPreviewOrder)
    const printOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error('Imprimante déconnectée. Vérifiez le câble puis réessayez.'))
      .mockResolvedValue(success)
    const lifecycle = createLifecycle()

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
        lifecycle={lifecycle}
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
    expect(lifecycle.failPrinting).toHaveBeenCalledOnce()
  })

  it('conserve le ticket client imprimé et ne reprend que la préparation après un échec partiel', async () => {
    const createOrder = vi.fn().mockResolvedValue(printPreviewOrder)
    const printOrder = vi
      .fn()
      .mockRejectedValueOnce(
        new OrderPrintError('Ticket de préparation interrompu.', 'preparationTicket'),
      )
      .mockResolvedValue({
        ...success,
        completedDocuments: ['preparationTicket'],
      })
    const lifecycle = createLifecycle()

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        createOrder={createOrder}
        lifecycle={lifecycle}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))
    expect(await screen.findByText(/impression partielle à reprendre/)).toBeInTheDocument()
    expect(lifecycle.failPrinting).toHaveBeenCalledWith(
      printPreviewOrder.id,
      'both',
      ['customerReceipt'],
      'Ticket de préparation interrompu.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Réessayer l’impression' }))
    expect(await screen.findByRole('heading', { name: 'Commande validée' })).toBeInTheDocument()
    expect(printOrder.mock.calls[1]?.[1]).toMatchObject({ selection: 'preparation' })
  })

  it('ne réimprime pas automatiquement une ancienne commande dont les tickets sont inconnus', async () => {
    const legacyOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'unknown' as const,
        customerReceipt: 'unknown' as const,
        preparationTicket: 'unknown' as const,
      },
    }
    const printOrder = vi.fn()

    render(
      <CheckoutFlow
        items={legacyOrder.items}
        initialOrder={legacyOrder}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
        lifecycle={createLifecycle(legacyOrder)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les tickets' }))

    expect(printOrder).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'L’état des anciens tickets est inconnu. Vérifiez les tickets déjà sortis puis choisissez explicitement celui à réimprimer.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ticket client' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Préparation' })).toBeInTheDocument()
  })
})
