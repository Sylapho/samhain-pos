import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { printPreviewOrder } from '../../mocks/printOrder'
import { OrderPrintError, type PrintJobResult } from '../../printing/types'
import { IndexedDbOrderRepository } from '../../services/orderRepository'
import { OrderService } from '../../services/orderService'
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
  it('exige un choix explicite du moyen de paiement avant validation', () => {
    const createOrder = vi.fn()

    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        createOrder={createOrder}
      />,
    )

    const card = screen.getByRole('button', { name: 'Carte bancaire' })
    const cash = screen.getByRole('button', { name: 'Espèces' })
    const checkout = screen.getByRole('button', { name: 'Encaisser et imprimer' })

    expect(card).toHaveAttribute('aria-pressed', 'false')
    expect(cash).toHaveAttribute('aria-pressed', 'false')
    expect(checkout).toBeDisabled()
    expect(
      screen.getByText('Sélectionnez Carte bancaire ou Espèces pour continuer.'),
    ).toBeInTheDocument()

    fireEvent.click(card)
    expect(checkout).toBeEnabled()
    expect(screen.queryByRole('heading', { name: 'Paiement en espèces' })).not.toBeInTheDocument()

    fireEvent.click(cash)

    expect(cash).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Paiement sélectionné : Espèces')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Paiement en espèces' })).toBeInTheDocument()
    expect(checkout).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /^5$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^0$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^0$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^0$/ }))

    expect(screen.getByText(/^8,50/)).toBeInTheDocument()
    expect(checkout).toBeEnabled()
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('affiche immédiatement la monnaie et empêche l’encaissement si le montant devient insuffisant', () => {
    render(
      <CheckoutFlow
        items={printPreviewOrder.items}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        createOrder={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    const checkout = screen.getByRole('button', { name: 'Encaisser et imprimer' })
    fireEvent.click(screen.getByRole('button', { name: /^Montant exact/ }))

    expect(screen.getByText(/^0,00/)).toBeInTheDocument()
    expect(checkout).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Effacer le dernier chiffre' }))

    expect(screen.getByText(/^Il manque/)).toBeInTheDocument()
    expect(checkout).toBeDisabled()
  })

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
    fireEvent.click(screen.getByRole('button', { name: /^Montant exact/ }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))
    expect(await screen.findByText(/impression partielle à reprendre/)).toBeInTheDocument()
    expect(screen.getByText('Ticket client : imprimé')).toBeInTheDocument()
    expect(screen.getByText('Ticket de préparation : échec — à reprendre')).toBeInTheDocument()
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
        'L’état de certains tickets est incertain. Vérifiez les tickets déjà sortis puis choisissez explicitement celui à réimprimer.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ticket client' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Préparation' })).toBeInTheDocument()
  })

  it('reprend la préparation après réouverture et plusieurs échecs sans réimprimer le client', async () => {
    const indexedDb = new IDBFactory()
    const repository = new IndexedDbOrderRepository(indexedDb)
    const service = new OrderService(repository)
    const order = await service.createOrder(printPreviewOrder.items, 'card')
    await service.beginPrinting(order.id, 'both')
    await service.failPrinting(order.id, 'both', ['customerReceipt'], 'Préparation interrompue')
    await repository.close()
    const reopenedRepository = new IndexedDbOrderRepository(indexedDb)
    const reopened = new OrderService(reopenedRepository)
    const [recovered] = await reopened.getRecoverableOrders()
    const printOrder = vi
      .fn()
      .mockRejectedValueOnce(
        new OrderPrintError('Déconnexion', 'connection', 'USB_PRINT_ERROR', []),
      )
      .mockResolvedValue({ ...success, completedDocuments: ['preparationTicket'] })
    render(
      <CheckoutFlow
        items={[]}
        initialOrder={recovered}
        lifecycle={reopened}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
      />,
    )
    expect(screen.getByText('Ticket client : imprimé')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Reprendre l’impression' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await screen.findByText(/Commande .* enregistrée. Déconnexion/)
    expect(printOrder).toHaveBeenCalledOnce()
    expect(screen.getByText('Ticket client : imprimé')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))
    await screen.findByRole('heading', { name: 'Commande validée' })
    expect(printOrder).toHaveBeenCalledTimes(2)
    for (const [printedOrder, options] of printOrder.mock.calls) {
      expect(printedOrder.id).toBe(order.id)
      expect(options.selection).toBe('preparation')
    }
    expect(await reopened.getRecoverableOrders()).toEqual([])
    await reopenedRepository.close()
  })

  it.each([
    ['customerCut', ['customerReceipt'], 'partial'],
    ['preparationCut', ['customerReceipt', 'preparationTicket'], 'printed'],
  ] as const)(
    'ne réimprime pas les documents terminés après %s',
    async (stage, documents, status) => {
      const repository = new IndexedDbOrderRepository(new IDBFactory())
      const service = new OrderService(repository)
      const order = await service.createOrder(printPreviewOrder.items, 'card')
      const printOrder = vi
        .fn()
        .mockRejectedValue(new OrderPrintError('Coupe échouée', stage, undefined, [...documents]))
      render(
        <CheckoutFlow
          items={[]}
          initialOrder={order}
          lifecycle={service}
          onCancel={vi.fn()}
          onNewOrder={vi.fn()}
          printOrder={printOrder}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))
      await screen.findByText(/Coupe échouée/)
      expect((await service.getOrders())[0]?.printing.status).toBe(status)
      expect(screen.getByText('Ticket client : imprimé')).toBeInTheDocument()
      if (status === 'printed') {
        expect(screen.getByRole('heading', { name: 'Commande validée' })).toBeInTheDocument()
        expect(
          screen.queryByRole('button', { name: 'Reprendre l’impression' }),
        ).not.toBeInTheDocument()
      }
      expect(printOrder).toHaveBeenCalledOnce()
      await repository.close()
    },
  )

  it('exige une vérification si la sauvegarde finale échoue après le transfert', async () => {
    const repository = new IndexedDbOrderRepository(new IDBFactory())
    const service = new OrderService(repository)
    const order = await service.createOrder(printPreviewOrder.items, 'card')
    vi.spyOn(service, 'completePrinting').mockRejectedValueOnce(new Error('Stockage indisponible'))
    const printOrder = vi.fn().mockResolvedValue(success)
    render(
      <CheckoutFlow
        items={[]}
        initialOrder={order}
        lifecycle={service}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))
    await screen.findByText(/L’état final de l’impression n’a pas pu être sauvegardé/)
    expect((await service.getRecoverableOrders())[0]?.printing.status).toBe('unknown')
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les tickets' }))
    expect(printOrder).toHaveBeenCalledOnce()
    expect(screen.getByText(/L’état de certains tickets est incertain/)).toBeInTheDocument()
    await repository.close()
  })

  it('enregistre la reprise explicite d’un ticket incertain sans relancer le client déjà imprimé', async () => {
    const indexedDb = new IDBFactory()
    const repository = new IndexedDbOrderRepository(indexedDb)
    const service = new OrderService(repository)
    const order = await service.createOrder(printPreviewOrder.items, 'card')
    await service.failPrinting(order.id, 'both', ['customerReceipt'], 'Préparation échouée')
    await service.beginPrinting(order.id, 'preparation')
    await repository.close()
    const restartedRepository = new IndexedDbOrderRepository(indexedDb)
    const restarted = new OrderService(restartedRepository)
    const [recovered] = await restarted.getRecoverableOrders()
    const printOrder = vi
      .fn()
      .mockResolvedValue({ ...success, completedDocuments: ['preparationTicket'] })
    render(
      <CheckoutFlow
        items={[]}
        initialOrder={recovered}
        lifecycle={restarted}
        onCancel={vi.fn()}
        onNewOrder={vi.fn()}
        printOrder={printOrder}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les tickets' }))
    expect(printOrder).not.toHaveBeenCalled()
    expect(screen.getByText('Ticket client : imprimé')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Préparation' }))
    await screen.findByText('Impression terminée : tous les tickets demandés ont été envoyés.')
    expect(printOrder).toHaveBeenCalledOnce()
    expect(printOrder.mock.calls[0]?.[1]).toMatchObject({ selection: 'preparation' })
    expect(await restarted.getRecoverableOrders()).toEqual([])
    await restartedRepository.close()
  })
})
