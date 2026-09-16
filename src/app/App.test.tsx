import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import type { PrintJobResult } from '../printing/types'
import { useCartStore } from '../store/cartStore'
import type { Order } from '../types/order'
import { App } from './App'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
} from '../services/terminalConfigurationService'
import {
  LocalStorageResponsibleCredentialRepository,
  ResponsibleModeService,
} from '../services/responsibleModeService'

const printSuccess: PrintJobResult = {
  ok: true,
  bytesWritten: 100,
  completedDocuments: ['preparationTicket'],
  warnings: [],
}

function failedPrintingLifecycle(orders: Order[]) {
  const ordersById = new Map(orders.map((order) => [order.id, order]))
  return {
    beginPrinting: vi.fn(async (id: string) => {
      const order = ordersById.get(id)!
      return {
        ...order,
        printing: {
          ...order.printing,
          status: 'unknown' as const,
          customerReceipt:
            order.printing.customerReceipt === 'not_requested'
              ? ('not_requested' as const)
              : ('unknown' as const),
          preparationTicket: 'unknown' as const,
          attempts: order.printing.attempts + 1,
        },
      }
    }),
    completePrinting: vi.fn(),
    failPrinting: vi.fn(
      async (id: string, _selection: unknown, _completed: unknown, message: string) => {
        const order = ordersById.get(id)!
        const failed = {
          ...order,
          printing: {
            ...order.printing,
            status: 'failed' as const,
            customerReceipt:
              order.printing.customerReceipt === 'not_requested'
                ? ('not_requested' as const)
                : ('failed' as const),
            preparationTicket: 'failed' as const,
            lastError: message,
          },
        }
        ordersById.set(id, failed)
        return failed
      },
    ),
  }
}

describe('caisse', () => {
  beforeEach(() => {
    useCartStore.getState().clearCart()
    localStorage.clear()
    new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'terminal-a',
    ).provision({ terminalCode: 'A', displayName: 'Caisse A' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('désactive la validation et l’annulation lorsque la commande est vide', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Configurer Caisse A' })).toHaveTextContent('Code A')
    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annuler la commande' })).toBeDisabled()
  })

  it('enchaîne le provisioning initial avec la création obligatoire du PIN responsable', async () => {
    const configured = {
      terminalId: 'terminal-c',
      terminalCode: 'C' as const,
      displayName: 'Caisse C',
      provisionedAt: '2026-09-10T10:00:00.000Z',
    }
    const provision = vi.fn().mockReturnValue(configured)
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )

    render(
      <App
        terminalManagement={{
          load: () => null,
          provision,
          rename: vi.fn(),
          reprovision: vi.fn(),
        }}
        responsibleMode={responsibleMode}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Configurer cette tablette' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Valider la commande' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'C' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configurer la tablette' }))

    expect(provision).toHaveBeenCalledWith({ terminalCode: 'C', displayName: 'Caisse C' })
    expect(
      screen.getByRole('dialog', { name: 'Configurer le mode responsable' }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Nouveau PIN'), { target: { value: '4826' } })
    fireEvent.change(screen.getByLabelText('Confirmer le PIN'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Créer le PIN' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Configurer le mode responsable' }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Configurer Caisse C' })).toHaveTextContent('Code C')
  })

  it('demande le mode responsable avant d’ouvrir la configuration existante', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')
    responsibleMode.lock()

    render(<App responsibleMode={responsibleMode} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configurer Caisse A' }))

    expect(screen.getByRole('dialog', { name: 'Mode responsable' })).toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'Configuration de la caisse' }),
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))
    expect(
      await screen.findByRole('dialog', { name: 'Configuration de la caisse' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(responsibleMode.isUnlocked()).toBe(false)
  })

  it('protège l’écran de clôture et sauvegarde par le mode responsable', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')
    responsibleMode.lock()

    render(
      <App
        responsibleMode={responsibleMode}
        ledgerManagementDependencies={{
          ledgerService: {
            getLastClosureEnd: vi.fn(async () => null),
          } as never,
          backupService: {} as never,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clôture & sauvegarde' }))

    expect(screen.getByRole('dialog', { name: 'Mode responsable' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Clôture et sauvegarde' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))

    expect(await screen.findByRole('dialog', { name: 'Clôture et sauvegarde' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(responsibleMode.isUnlocked()).toBe(false)
  })

  it('autorise le reprovisionnement après vérification sans impression à reprendre', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')

    render(<App responsibleMode={responsibleMode} loadRecoverableOrders={vi.fn(async () => [])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configurer Caisse A' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reprovisionner cette tablette' })).toBeEnabled(),
    )
  })

  it('bloque le reprovisionnement lorsqu’une impression est à reprendre', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')
    const partialOrder = {
      ...structuredClone(printPreviewOrder),
      printing: {
        ...printPreviewOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }

    render(
      <App
        responsibleMode={responsibleMode}
        loadRecoverableOrders={vi.fn(async () => [partialOrder])}
      />,
    )
    await screen.findByText('1 impression(s) à reprendre')
    fireEvent.click(screen.getByRole('button', { name: 'Configurer Caisse A' }))

    expect(
      await screen.findByRole('button', { name: 'Reprovisionner cette tablette' }),
    ).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/impressions sont à reprendre/)
  })

  it('bloque l’encaissement lorsqu’un remplacement interrompu doit être repris', () => {
    render(<App loadPendingTabletReplacement={() => true} />)

    expect(screen.getByRole('alert')).toHaveTextContent(/remplacement de tablette a été interrompu/)
    expect(screen.queryByRole('button', { name: 'Valider la commande' })).not.toBeInTheDocument()
  })

  it('laisse encaisser une ancienne installation sans PIN mais impose sa configuration pour administrer', () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    render(<App responsibleMode={responsibleMode} />)

    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Mode responsable/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Configurer Caisse A' }))
    expect(
      screen.getByRole('dialog', { name: 'Configurer le mode responsable' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument()
  })

  it('n’annonce pas l’imprimante prête avant la fin de la vérification réelle', async () => {
    let finishProbe: ((status: 'ready') => void) | undefined
    const probePrinterStatus = vi.fn(
      () =>
        new Promise<'ready'>((resolve) => {
          finishProbe = resolve
        }),
    )

    render(<App probePrinterStatus={probePrinterStatus} />)

    expect(screen.getByText('Imprimante : Vérification…')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Prête')).not.toBeInTheDocument()

    finishProbe?.('ready')
    expect(await screen.findByText('Imprimante : Prête')).toBeInTheDocument()
  })

  it('reflète une déconnexion détectée lors de la vérification suivante', async () => {
    vi.useFakeTimers()
    const probePrinterStatus = vi
      .fn<() => Promise<'ready' | 'disconnected'>>()
      .mockResolvedValueOnce('ready')
      .mockResolvedValue('disconnected')

    render(<App probePrinterStatus={probePrinterStatus} />)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Prête')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Déconnectée')).toBeInTheDocument())
  })

  it('suit le retrait puis le retour du papier sans recharger l’application', async () => {
    vi.useFakeTimers()
    const probePrinterStatus = vi
      .fn<() => Promise<'ready' | 'paper-out'>>()
      .mockResolvedValueOnce('ready')
      .mockResolvedValueOnce('paper-out')
      .mockResolvedValue('ready')

    render(<App probePrinterStatus={probePrinterStatus} />)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Prête')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() =>
      expect(screen.getByText('Imprimante : Papier épuisé')).toBeInTheDocument(),
    )

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Prête')).toBeInTheDocument())
  })

  it('affiche une erreur si la vérification matérielle échoue', async () => {
    render(<App probePrinterStatus={async () => 'error'} />)

    expect(await screen.findByText('Imprimante : Erreur imprimante')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Prête')).not.toBeInTheDocument()
  })

  it('indique clairement un capot ouvert', async () => {
    render(<App probePrinterStatus={async () => 'cover-open'} />)

    expect(await screen.findByText('Imprimante : Capot ouvert')).toBeInTheDocument()
  })

  it('n’annonce pas prête si la sonde ne peut pas lire le statut', async () => {
    render(<App probePrinterStatus={async () => Promise.reject(new Error('USB indisponible'))} />)

    expect(await screen.findByText('Imprimante : Statut illisible')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Prête')).not.toBeInTheDocument()
  })

  it('ajoute un produit simple en un appui puis modifie sa quantité', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Burger spécial Samhain, 16,00/ }))
    const quantity = screen.getByLabelText('Quantité Burger spécial Samhain')
    expect(quantity).toBeInTheDocument()
    fireEvent.click(
      within(quantity).getByRole('button', { name: 'Augmenter Burger spécial Samhain' }),
    )
    expect(within(quantity).getByText('2')).toBeInTheDocument()
  })

  it('annule puis valide une personnalisation et la retrouve à la réouverture', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Burger spécial Samhain, 16,00/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    const cheddar = screen.getByRole('checkbox', { name: 'Cheddar' })
    expect(cheddar).toBeChecked()
    fireEvent.click(cheddar)
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.queryByText('Sans cheddar')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    expect(screen.getByRole('checkbox', { name: 'Cheddar' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheddar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(screen.getByText('Sans cheddar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    expect(screen.getByRole('checkbox', { name: 'Cheddar' })).not.toBeChecked()
  })

  it('applique la taille par défaut puis permet de la modifier depuis le panier', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Sans alcool/ }))
    fireEvent.click(screen.getByRole('button', { name: /Coca-Cola, à partir de 2,50/ }))
    expect(screen.getByRole('button', { name: /25 cl/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Coca-Cola' }))
    expect(screen.getByText('Taille : 25 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    fireEvent.click(screen.getByRole('button', { name: /50 cl/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.getByText('Taille : 25 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    expect(screen.getByRole('button', { name: /25 cl/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /50 cl/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(screen.getByText('Taille : 50 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    expect(screen.getByRole('button', { name: /50 cl/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('compose un menu enfant puis ouvre l’encaissement', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Menu enfant/ }))
    fireEvent.click(screen.getByRole('button', { name: /Nuggets/ }))
    fireEvent.click(screen.getByRole('button', { name: /Glace/ }))
    fireEvent.click(screen.getByRole('button', { name: /Jus de pomme/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Menu enfant' }))
    expect(screen.getByText('Dessert : Glace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
    expect(screen.getByRole('dialog', { name: 'Encaissement' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Mode responsable/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Carte bancaire' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Montant exact/ }))
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: /Imprimer le ticket client/ })).toBeChecked()
  })

  it('protège l’annulation de la commande par une confirmation', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la commande' }))
    expect(screen.getByRole('dialog', { name: 'Annuler cette commande ?' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Annuler la commande' })[1]!)
    expect(screen.getByText('Commande vide')).toBeInTheDocument()
  })

  it('propose de reprendre une impression persistée après redémarrage', async () => {
    const partialOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }

    render(<App loadRecoverableOrders={async () => [partialOrder]} />)

    expect(await screen.findByText('1 impression(s) à reprendre')).toBeInTheDocument()
    expect(screen.getByText('Commande A-0001 payée et enregistrée')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))

    const checkout = screen.getByRole('dialog', { name: 'Encaissement' })
    expect(checkout).toBeInTheDocument()
    expect(
      screen.getByText('Paiement enregistré · impression partielle à reprendre'),
    ).toBeInTheDocument()
    expect(
      within(checkout).getByRole('button', { name: 'Reprendre l’impression' }),
    ).toBeInTheDocument()
  })

  it('vide le panier après une vente mise en attente et conserve sa bannière de reprise', async () => {
    const failedOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'failed' as const,
        customerReceipt: 'failed' as const,
        preparationTicket: 'failed' as const,
      },
    }
    const createOrder = vi.fn().mockResolvedValue(printPreviewOrder)
    const printOrder = vi.fn().mockRejectedValue(new Error('Imprimante déconnectée'))
    const lifecycle = failedPrintingLifecycle([failedOrder])
    const loadRecoverableOrders = vi.fn().mockResolvedValue([])

    render(
      <App
        loadRecoverableOrders={loadRecoverableOrders}
        checkoutDependencies={{ createOrder, printOrder, lifecycle }}
      />,
    )
    await waitFor(() => expect(loadRecoverableOrders).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))

    await screen.findByText(/Commande A-0001 enregistrée. Imprimante déconnectée/)
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en attente et nouvelle commande' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en attente' }))

    expect(screen.getByText('Commande vide')).toBeInTheDocument()
    expect(screen.getByText('1 impression(s) à reprendre')).toBeInTheDocument()
    expect(screen.getByText('Commande A-0001 payée et enregistrée')).toBeInTheDocument()
    expect(createOrder).toHaveBeenCalledOnce()
  })

  it('conserve plusieurs ventes mises en attente et leurs numéros distincts', async () => {
    const orderA = { ...structuredClone(printPreviewOrder), id: 'order-a' }
    const orderB = {
      ...structuredClone(printPreviewOrder),
      id: 'order-b',
      orderNumber: 'A-0002',
      receiptNumber: 'R-A-20260901-0002',
      createdAt: '2026-09-01T18:16:00.000Z',
      paidAt: '2026-09-01T18:16:00.000Z',
    }
    const failedOrders = [orderA, orderB].map((order) => ({
      ...order,
      printing: {
        ...order.printing,
        status: 'failed' as const,
        customerReceipt: 'failed' as const,
        preparationTicket: 'failed' as const,
      },
    }))
    const createOrder = vi.fn().mockResolvedValueOnce(orderA).mockResolvedValueOnce(orderB)
    const printOrder = vi.fn().mockRejectedValue(new Error('Imprimante déconnectée'))
    const lifecycle = failedPrintingLifecycle(failedOrders)

    render(
      <App
        loadRecoverableOrders={async () => []}
        checkoutDependencies={{ createOrder, printOrder, lifecycle }}
      />,
    )

    for (let sale = 0; sale < 2; sale += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
      fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
      fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
      fireEvent.click(screen.getByRole('button', { name: 'Encaisser et imprimer' }))
      await screen.findByText(/enregistrée. Imprimante déconnectée/)
      fireEvent.click(
        screen.getByRole('button', { name: 'Mettre en attente et nouvelle commande' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Mettre en attente' }))
    }

    expect(screen.getByText('2 impression(s) à reprendre')).toBeInTheDocument()
    expect(screen.getByText('Commande A-0001 payée et enregistrée')).toBeInTheDocument()
    expect(createOrder).toHaveBeenCalledTimes(2)
    expect(new Set(failedOrders.map((order) => order.id))).toEqual(new Set(['order-a', 'order-b']))
  })

  it('retire une reprise réussie et propose immédiatement la suivante sans recréer de vente', async () => {
    const orderA = {
      ...structuredClone(printPreviewOrder),
      id: 'order-a',
      printing: {
        ...printPreviewOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }
    const orderB = {
      ...structuredClone(orderA),
      id: 'order-b',
      orderNumber: 'A-0002',
      receiptNumber: 'R-A-20260901-0002',
      createdAt: '2026-09-01T18:16:00.000Z',
      paidAt: '2026-09-01T18:16:00.000Z',
    }
    const startedOrder = {
      ...orderA,
      printing: {
        ...orderA.printing,
        status: 'unknown' as const,
        preparationTicket: 'unknown' as const,
      },
    }
    const printedOrder = {
      ...orderA,
      printing: {
        ...orderA.printing,
        status: 'printed' as const,
        preparationTicket: 'printed' as const,
      },
    }
    const createOrder = vi.fn()
    const lifecycle = {
      beginPrinting: vi.fn().mockResolvedValue(startedOrder),
      completePrinting: vi.fn().mockResolvedValue(printedOrder),
      failPrinting: vi.fn(),
    }

    render(
      <App
        loadRecoverableOrders={async () => [orderA, orderB]}
        checkoutDependencies={{
          createOrder,
          lifecycle,
          printOrder: vi.fn().mockResolvedValue(printSuccess),
        }}
      />,
    )

    expect(await screen.findByText('2 impression(s) à reprendre')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Encaissement' })).getByRole('button', {
        name: 'Reprendre l’impression',
      }),
    )
    await screen.findByRole('heading', { name: 'Commande validée' })
    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle commande' }))

    expect(screen.getByText('1 impression(s) à reprendre')).toBeInTheDocument()
    expect(screen.getByText('Commande A-0002 payée et enregistrée')).toBeInTheDocument()
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('préserve le panier courant en mettant en attente la reprise d’une ancienne commande', async () => {
    const partialOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }

    render(<App loadRecoverableOrders={async () => [partialOrder]} />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    expect(await screen.findByText('1 impression(s) à reprendre')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Encaissement' })).getByRole('button', {
        name: 'Mettre en attente et nouvelle commande',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en attente' }))

    expect(
      within(screen.getByLabelText('Commande en cours')).getByText('Omelette'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 impression(s) à reprendre')).toBeInTheDocument()
  })

  it('consulte une ancienne commande sans modifier la commande active', async () => {
    const historicalOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'printed' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'printed' as const,
      },
    }
    render(
      <App loadRecoverableOrders={async () => []} loadOrders={async () => [historicalOrder]} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))

    const activeOrder = screen.getByLabelText('Commande en cours')
    expect(within(activeOrder).getByText('Omelette')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Historique' }))
    expect(
      await screen.findByRole('dialog', { name: 'Historique des commandes' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Commande A-0001' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))

    expect(within(activeOrder).getByText('Omelette')).toBeInTheDocument()
    expect(within(activeOrder).getAllByText(/10,00/)).toHaveLength(3)
  })
})
