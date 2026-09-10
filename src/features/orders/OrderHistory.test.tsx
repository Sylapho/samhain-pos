import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../../mocks/printOrder'
import type { PrintJobResult } from '../../printing/types'
import { OrderHistory } from './OrderHistory'

const success: PrintJobResult = {
  ok: true,
  bytesWritten: 100,
  completedDocuments: ['customerReceipt'],
  warnings: [],
}

const printedOrder = {
  ...structuredClone(printPreviewOrder),
  printing: {
    ...printPreviewOrder.printing,
    status: 'printed' as const,
    customerReceipt: 'printed' as const,
    preparationTicket: 'printed' as const,
  },
}

describe('historique des commandes', () => {
  it('affiche la liste récente et le détail complet de la commande sélectionnée', async () => {
    const cashOrder = {
      ...printedOrder,
      id: 'order-a002',
      orderNumber: 'A-0002',
      receiptNumber: 'R-A-20260901-0002',
      paymentMethod: 'cash' as const,
      totalCents: 950,
      itemCount: 1,
      items: [
        {
          ...printedOrder.items[0]!,
          lineId: 'menu-detail',
          name: 'Menu test historique',
          quantity: 1,
          unitPriceCents: 950,
          options: [
            {
              groupId: 'plat',
              groupName: 'Plat',
              optionId: 'nuggets',
              optionName: 'Nuggets',
              priceDeltaCents: 0,
            },
          ],
        },
      ],
    }

    render(<OrderHistory onClose={vi.fn()} loadOrders={async () => [cashOrder, printedOrder]} />)

    expect(await screen.findByRole('button', { name: /Commande A-0002/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Commande A-0001/ })).toBeInTheDocument()
    const detail = screen.getByRole('article', { name: 'Commande A-0002' })
    expect(within(detail).getByText(/Espèces/)).toBeInTheDocument()
    expect(within(detail).getByText('Reçu R-A-20260901-0002')).toBeInTheDocument()
    expect(within(detail).getByText('Caisse : Caisse A')).toBeInTheDocument()
    expect(within(detail).getByText('Menu test historique')).toBeInTheDocument()
    expect(within(detail).getByText('Plat : Nuggets')).toBeInTheDocument()
    expect(within(detail).getByText('Impression : Imprimée')).toBeInTheDocument()
  })

  it.each([
    ['Ticket client', 'customer'],
    ['Préparation', 'preparation'],
    ['Les deux tickets', 'both'],
  ] as const)(
    'réimprime exactement la commande persistée avec l’action « %s »',
    async (buttonName, selection) => {
      const printOrder = vi.fn().mockResolvedValue(success)

      render(
        <OrderHistory
          onClose={vi.fn()}
          loadOrders={async () => [printedOrder]}
          printOrder={printOrder}
        />,
      )

      await screen.findByRole('heading', { name: 'Commande A-0001' })
      fireEvent.click(screen.getByRole('button', { name: buttonName }))

      await screen.findByText('Réimpression terminée pour la commande A-0001.')
      expect(printOrder).toHaveBeenCalledOnce()
      expect(printOrder).toHaveBeenCalledWith(printedOrder, {
        selection,
        printCustomerReceipt: true,
        reprint: true,
      })
    },
  )

  it('met à jour un état d’impression incomplet après une réimpression', async () => {
    const partialOrder = {
      ...printedOrder,
      printing: {
        ...printedOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }
    const startedOrder = {
      ...partialOrder,
      printing: {
        ...partialOrder.printing,
        status: 'partial' as const,
        preparationTicket: 'unknown' as const,
      },
    }
    const completedOrder = {
      ...startedOrder,
      printing: {
        ...startedOrder.printing,
        status: 'printed' as const,
        preparationTicket: 'printed' as const,
      },
    }
    const lifecycle = {
      beginPrinting: vi.fn().mockResolvedValue(startedOrder),
      completePrinting: vi.fn().mockResolvedValue(completedOrder),
      failPrinting: vi.fn(),
    }
    const printOrder = vi.fn().mockResolvedValue({
      ...success,
      completedDocuments: ['preparationTicket'],
    })
    const onOrderUpdated = vi.fn()

    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [partialOrder]}
        printOrder={printOrder}
        lifecycle={lifecycle}
        onOrderUpdated={onOrderUpdated}
      />,
    )

    await screen.findByRole('heading', { name: 'Commande A-0001' })
    fireEvent.click(screen.getByRole('button', { name: 'Préparation' }))

    await screen.findByText('Réimpression terminée pour la commande A-0001.')
    expect(lifecycle.beginPrinting).toHaveBeenCalledWith(partialOrder.id, 'preparation')
    expect(printOrder).toHaveBeenCalledWith(startedOrder, {
      selection: 'preparation',
      printCustomerReceipt: true,
      reprint: true,
    })
    expect(lifecycle.completePrinting).toHaveBeenCalledWith(partialOrder.id, 'preparation', [
      'preparationTicket',
    ])
    expect(onOrderUpdated).toHaveBeenLastCalledWith(completedOrder)
    await waitFor(() => {
      const detail = screen.getByRole('article', { name: 'Commande A-0001' })
      expect(within(detail).getByText('Impression : Imprimée')).toBeInTheDocument()
    })
  })

  it('bloque les appuis répétés et la fermeture pendant une réimpression', async () => {
    let finishPrint: ((result: PrintJobResult) => void) | undefined
    const printOrder = vi.fn(
      () =>
        new Promise<PrintJobResult>((resolve) => {
          finishPrint = resolve
        }),
    )
    const onClose = vi.fn()

    render(
      <OrderHistory
        onClose={onClose}
        loadOrders={async () => [printedOrder]}
        printOrder={printOrder}
      />,
    )

    await screen.findByRole('heading', { name: 'Commande A-0001' })
    const reprintButton = screen.getByRole('button', { name: 'Les deux tickets' })
    fireEvent.click(reprintButton)
    fireEvent.click(reprintButton)

    expect(printOrder).toHaveBeenCalledOnce()
    const closeButton = screen.getByRole('button', { name: 'Fermer' })
    expect(closeButton).toBeDisabled()
    expect(screen.getByRole('button', { name: /Commande A-0001,/ })).toBeDisabled()
    fireEvent.click(closeButton)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finishPrint?.({ ...success, completedDocuments: [] }))
    expect(
      await screen.findByText('Réimpression terminée pour la commande A-0001.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeEnabled()
  })

  it('ne lance aucun ticket si l’état de reprise ne peut pas être sauvegardé', async () => {
    const partialOrder = {
      ...printedOrder,
      printing: {
        ...printedOrder.printing,
        status: 'failed' as const,
        preparationTicket: 'failed' as const,
      },
    }
    const lifecycle = {
      beginPrinting: vi.fn().mockRejectedValue(new Error('Stockage indisponible')),
      completePrinting: vi.fn(),
      failPrinting: vi.fn(),
    }
    const printOrder = vi.fn()

    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [partialOrder]}
        printOrder={printOrder}
        lifecycle={lifecycle}
      />,
    )

    await screen.findByRole('heading', { name: 'Commande A-0001' })
    fireEvent.click(screen.getByRole('button', { name: 'Préparation' }))

    expect(
      await screen.findByText(/Aucun ticket n’a été lancé car l’état de reprise/),
    ).toBeInTheDocument()
    expect(printOrder).not.toHaveBeenCalled()
  })
})
