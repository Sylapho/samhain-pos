import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../../mocks/printOrder'
import type { PrintJobResult } from '../../printing/types'
import type { CorrectionLedgerEntry } from '../../types/salesLedger'
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

function correction(
  type: 'cancellation' | 'refund',
  amountDeltaCents: number,
  reason = 'Erreur de saisie',
): CorrectionLedgerEntry {
  return {
    schemaVersion: 1,
    id: `correction:${type}:${amountDeltaCents}:${reason}`,
    sequence: 2,
    recordedAt: '2026-09-01T19:40:00.000Z',
    previousHash: 'previous',
    hash: 'hash',
    kind: 'correction',
    source: {
      softwareVersion: 'test',
      buildMode: 'test',
      terminal: printedOrder.terminal!,
      organization: {} as CorrectionLedgerEntry['source']['organization'],
    },
    correction: {
      operationId: `operation-${type}`,
      originalOrderId: printedOrder.id,
      originalOrderNumber: printedOrder.orderNumber,
      originalReceiptNumber: printedOrder.receiptNumber,
      type,
      reason,
      amountDeltaCents,
      paymentMethod: printedOrder.paymentMethod,
      originalSaleHash: null,
    },
  }
}

function ledgerService(entries: CorrectionLedgerEntry[] = []) {
  return {
    getEntries: vi.fn(async () => entries),
    cancelSale: vi.fn(),
    refundSale: vi.fn(),
  }
}

describe('historique des commandes', () => {
  it('ne propose aucune réimpression de préparation quand elle était non demandée', async () => {
    const customerOnlyOrder = {
      ...printedOrder,
      items: printedOrder.items.map((item) => ({ ...item, requiresPreparation: false })),
      printing: {
        ...printedOrder.printing,
        preparationTicket: 'not_requested' as const,
      },
    }
    const printOrder = vi.fn().mockResolvedValue(success)

    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [customerOnlyOrder]}
        printOrder={printOrder}
      />,
    )

    const detail = await screen.findByRole('article', { name: 'Commande A-0001' })
    expect(within(detail).getByText('Ticket de préparation : Non demandé')).toBeInTheDocument()
    expect(within(detail).queryByRole('button', { name: 'Préparation' })).not.toBeInTheDocument()
    expect(within(detail).queryByRole('button', { name: 'Les deux tickets' })).not.toBeInTheDocument()

    fireEvent.click(within(detail).getByRole('button', { name: 'Ticket client' }))
    await screen.findByText('Réimpression terminée pour la commande A-0001.')
    expect(printOrder).toHaveBeenCalledWith(customerOnlyOrder, {
      selection: 'customer',
      printCustomerReceipt: true,
      reprint: true,
    })
  })

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

  it('affiche une impression inconnue comme à vérifier sans la relancer à l’ouverture', async () => {
    const unknownOrder = {
      ...printedOrder,
      printing: {
        ...printedOrder.printing,
        status: 'unknown' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'unknown' as const,
      },
    }
    const printOrder = vi.fn()

    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [unknownOrder]}
        printOrder={printOrder}
      />,
    )

    const detail = await screen.findByRole('article', { name: 'Commande A-0001' })
    expect(within(detail).getByText('Impression : À vérifier')).toBeInTheDocument()
    expect(
      within(detail).getByText('Ticket de préparation : À vérifier avant réimpression'),
    ).toBeInTheDocument()
    expect(printOrder).not.toHaveBeenCalled()
  })

  it('affiche séparément la vente originale et ses corrections avec un statut dérivé', async () => {
    const refund = correction('refund', -500, 'Produit indisponible')
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        ledgerService={ledgerService([refund])}
      />,
    )

    const detail = await screen.findByRole('article', { name: 'Commande A-0001' })
    expect(within(detail).getByText('Statut : Partiellement remboursée')).toBeInTheDocument()
    expect(within(detail).getByText('Remboursement')).toBeInTheDocument()
    expect(within(detail).getByText(/-5,00/)).toBeInTheDocument()
    expect(within(detail).getByText('Motif : Produit indisponible')).toBeInTheDocument()
    expect(within(detail).getAllByText(/Caisse A/).length).toBeGreaterThan(0)
    expect(within(detail).getByText(/41,50/)).toBeInTheDocument()
  })

  it('protège l’ouverture de la correction par le mode responsable', async () => {
    const requestResponsibleAccess = vi.fn().mockResolvedValue(false)
    const service = ledgerService()
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        ledgerService={service}
        requestResponsibleAccess={requestResponsibleAccess}
      />,
    )

    await screen.findByText('Aucune correction enregistrée.')
    fireEvent.click(screen.getByRole('button', { name: 'Corriger la vente' }))
    await waitFor(() => expect(requestResponsibleAccess).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog', { name: 'Corriger la vente' })).not.toBeInTheDocument()
    expect(service.cancelSale).not.toHaveBeenCalled()
  })

  it('confirme une annulation une seule fois malgré deux appuis et recharge le journal', async () => {
    const service = ledgerService()
    const recorded = correction('cancellation', -printedOrder.totalCents)
    let finish: ((entry: CorrectionLedgerEntry) => void) | undefined
    service.cancelSale.mockImplementation(
      () =>
        new Promise<CorrectionLedgerEntry>((resolve) => {
          finish = resolve
        }),
    )
    service.getEntries.mockResolvedValueOnce([]).mockResolvedValueOnce([recorded])
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        ledgerService={service}
        requestResponsibleAccess={vi.fn().mockResolvedValue(true)}
        createOperationId={() => 'stable-operation-id'}
      />,
    )

    await screen.findByText('Aucune correction enregistrée.')
    fireEvent.click(screen.getByRole('button', { name: 'Corriger la vente' }))
    const dialog = await screen.findByRole('dialog', { name: 'Corriger la vente' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annulation totale' }))
    fireEvent.change(within(dialog).getByLabelText('Motif obligatoire'), {
      target: { value: 'Erreur de saisie' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vérifier la correction' }))
    const confirmation = screen.getByRole('alertdialog', { name: 'Confirmer l’annulation ?' })
    const submit = within(confirmation).getByRole('button', { name: 'Annuler la vente' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(service.cancelSale).toHaveBeenCalledOnce())
    expect(service.cancelSale).toHaveBeenCalledWith(
      printedOrder.id,
      'Erreur de saisie',
      'stable-operation-id',
    )
    await act(async () => finish?.(recorded))
    expect(await screen.findByText('Statut : Annulée')).toBeInTheDocument()
    expect(screen.getByText(/Aucun justificatif n’a été imprimé/)).toBeInTheDocument()
    expect(service.getEntries).toHaveBeenCalledTimes(2)
  })

  it('rembourse uniquement le montant restant et conserve la même clé idempotente', async () => {
    const priorRefund = correction('refund', -500, 'Premier remboursement')
    const service = ledgerService([priorRefund])
    service.refundSale.mockResolvedValue(correction('refund', -(printedOrder.totalCents - 500)))
    service.getEntries
      .mockResolvedValueOnce([priorRefund])
      .mockResolvedValueOnce([
        priorRefund,
        correction('refund', -(printedOrder.totalCents - 500), 'Remboursement du reste'),
      ])
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        ledgerService={service}
        requestResponsibleAccess={vi.fn().mockResolvedValue(true)}
        createOperationId={() => 'refund-operation-id'}
      />,
    )

    await screen.findByText('Statut : Partiellement remboursée')
    fireEvent.click(screen.getByRole('button', { name: 'Corriger la vente' }))
    const dialog = await screen.findByRole('dialog', { name: 'Corriger la vente' })
    expect(within(dialog).getByRole('button', { name: 'Annulation totale' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remboursement total' }))
    fireEvent.change(within(dialog).getByLabelText('Motif obligatoire'), {
      target: { value: 'Remboursement du reste' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vérifier la correction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rembourser la vente' }))

    await waitFor(() =>
      expect(service.refundSale).toHaveBeenCalledWith(
        printedOrder.id,
        printedOrder.totalCents - 500,
        'Remboursement du reste',
        'refund-operation-id',
      ),
    )
    expect(await screen.findByText('Statut : Remboursée')).toBeInTheDocument()
  })

  it('affiche le refus si le mode responsable expire avant la confirmation', async () => {
    const service = ledgerService()
    service.cancelSale.mockRejectedValue(new Error('Le mode responsable a expiré.'))
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        ledgerService={service}
        requestResponsibleAccess={vi.fn().mockResolvedValue(true)}
      />,
    )

    await screen.findByText('Aucune correction enregistrée.')
    fireEvent.click(screen.getByRole('button', { name: 'Corriger la vente' }))
    const dialog = await screen.findByRole('dialog', { name: 'Corriger la vente' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annulation totale' }))
    fireEvent.change(within(dialog).getByLabelText('Motif obligatoire'), {
      target: { value: 'Erreur de saisie' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vérifier la correction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la vente' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Le mode responsable a expiré.')
    expect(
      screen.getByRole('button', { name: 'Déverrouiller le mode responsable' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Commande A-0001' })).toBeInTheDocument()
    expect(service.getEntries).toHaveBeenCalledOnce()
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

    await waitFor(() => expect(printOrder).toHaveBeenCalledOnce())
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

  it.each(['Ticket client', 'Les deux tickets'])(
    'demande le mode responsable avant « %s » quand le ticket client est déjà imprimé',
    async (buttonName) => {
      const printOrder = vi.fn()
      const requestResponsibleAccess = vi.fn().mockResolvedValue(false)
      render(
        <OrderHistory
          onClose={vi.fn()}
          loadOrders={async () => [printedOrder]}
          printOrder={printOrder}
          requestResponsibleAccess={requestResponsibleAccess}
        />,
      )

      await screen.findByRole('heading', { name: 'Commande A-0001' })
      fireEvent.click(screen.getByRole('button', { name: buttonName }))

      await waitFor(() => expect(requestResponsibleAccess).toHaveBeenCalledOnce())
      expect(printOrder).not.toHaveBeenCalled()
    },
  )

  it('imprime exactement une fois après une autorisation responsable réussie', async () => {
    const printOrder = vi.fn().mockResolvedValue(success)
    const requestResponsibleAccess = vi.fn().mockResolvedValue(true)
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [printedOrder]}
        printOrder={printOrder}
        requestResponsibleAccess={requestResponsibleAccess}
      />,
    )

    await screen.findByRole('heading', { name: 'Commande A-0001' })
    fireEvent.click(screen.getByRole('button', { name: 'Ticket client' }))

    await screen.findByText('Réimpression terminée pour la commande A-0001.')
    expect(requestResponsibleAccess).toHaveBeenCalledOnce()
    expect(printOrder).toHaveBeenCalledOnce()
  })

  it('reprend un ticket client échoué sans demander le mode responsable', async () => {
    const failedOrder = {
      ...printedOrder,
      printing: {
        ...printedOrder.printing,
        status: 'failed' as const,
        customerReceipt: 'failed' as const,
      },
    }
    const startedOrder = {
      ...failedOrder,
      printing: { ...failedOrder.printing, customerReceipt: 'unknown' as const },
    }
    const completedOrder = {
      ...failedOrder,
      printing: {
        ...failedOrder.printing,
        status: 'printed' as const,
        customerReceipt: 'printed' as const,
      },
    }
    const lifecycle = {
      beginPrinting: vi.fn().mockResolvedValue(startedOrder),
      completePrinting: vi.fn().mockResolvedValue(completedOrder),
      failPrinting: vi.fn(),
    }
    const requestResponsibleAccess = vi.fn()
    const printOrder = vi.fn().mockResolvedValue(success)
    render(
      <OrderHistory
        onClose={vi.fn()}
        loadOrders={async () => [failedOrder]}
        printOrder={printOrder}
        lifecycle={lifecycle}
        requestResponsibleAccess={requestResponsibleAccess}
      />,
    )

    await screen.findByRole('heading', { name: 'Commande A-0001' })
    fireEvent.click(screen.getByRole('button', { name: 'Ticket client' }))

    await screen.findByText('Réimpression terminée pour la commande A-0001.')
    expect(requestResponsibleAccess).not.toHaveBeenCalled()
    expect(lifecycle.beginPrinting).toHaveBeenCalledOnce()
    expect(printOrder).toHaveBeenCalledOnce()
  })
})
