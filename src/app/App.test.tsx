import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import type { PrintJobResult } from '../printing/types'
import { useCartStore } from '../store/cartStore'
import type { Order } from '../types/order'
import { initialCatalogProducts } from '../data/initialCatalog'
import { witchesCatalogProducts } from '../data/witchesCatalog'
import { witchesCategories } from '../data/witchesCategories'
import { App as ProductionApp } from './App'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
} from '../services/terminalConfigurationService'
import {
  LocalStorageResponsibleCredentialRepository,
  ResponsibleModeService,
} from '../services/responsibleModeService'
import { IndexedDbCatalogRepository } from '../services/catalogRepository'
import { IDBFactory } from 'fake-indexeddb'
import { initialCategories } from '../data/initialCategories'
import { createCartItemDraft } from '../utils/cart'
import { CatalogService } from '../services/catalogService'
import { sha256Hex } from '../utils/integrity'
import { synchronizationService } from '../services/synchronizationService'
import { IndexedDbOrderRepository } from '../services/orderRepository'
import { OrderService } from '../services/orderService'
import { CheckoutService } from '../services/checkoutService'

function App(props: ComponentProps<typeof ProductionApp>) {
  const cashSession = {
    id: 'session-a',
    terminal: { terminalId: 'terminal-a', terminalCode: 'A' as const, displayName: 'Caisse A' },
    periodStart: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    openingFloatCents: 15_000,
  }
  return (
    <ProductionApp
      initialCatalog={initialCatalogProducts}
      initialCategories={[...initialCategories]}
      cashSessionService={{
        getActiveSession: vi.fn(async () => cashSession),
        openSession: vi.fn(async (amountCents: number) => ({
          ...cashSession,
          openingFloatCents: amountCents,
        })),
        updateOpeningFloat: vi.fn(async (amountCents: number) => ({
          ...cashSession,
          openingFloatCents: amountCents,
        })),
      }}
      initialCashSession={cashSession}
      {...props}
    />
  )
}

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
    vi.restoreAllMocks()
  })

  it('bloque les ventes jusqu’à la validation obligatoire du fond de caisse', async () => {
    const openedSession = {
      id: 'session-new',
      terminal: { terminalId: 'terminal-a', terminalCode: 'A' as const, displayName: 'Caisse A' },
      periodStart: '2026-09-18T08:00:00.000Z',
      createdAt: '2026-09-18T08:00:00.000Z',
      openingFloatCents: 15_000,
    }
    const openSession = vi.fn(async () => openedSession)

    render(
      <ProductionApp
        initialCatalog={initialCatalogProducts}
        initialCategories={[...initialCategories]}
        loadRecoverableOrders={vi.fn(async () => [])}
        loadRecoverableIntents={vi.fn(async () => [])}
        cashSessionService={{
          getActiveSession: vi.fn(async () => null),
          openSession,
          updateOpeningFloat: vi.fn(),
        }}
      />,
    )

    expect(await screen.findByRole('dialog', { name: 'Fond de caisse' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Menu enfant/ })).not.toBeInTheDocument()
    for (const digit of ['1', '5', '0', '0', '0']) {
      fireEvent.click(screen.getByRole('button', { name: digit }))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Valider le fond de caisse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }))

    expect(await screen.findByRole('button', { name: /Menu enfant/ })).toBeInTheDocument()
    expect(openSession).toHaveBeenCalledWith(15_000)
  })

  it('désactive la validation et l’annulation lorsque la commande est vide', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Configurer Caisse A' })).toHaveTextContent('Code A')
    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annuler la commande' })).toBeDisabled()
  })

  it('enchaîne le provisioning initial avec la création obligatoire du PIN responsable', async () => {
    const configured = {
      terminalId: 'terminal-w',
      terminalCode: 'W' as const,
      displayName: 'Caisse W',
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
    fireEvent.click(screen.getByRole('button', { name: 'W' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configurer la tablette' }))

    expect(provision).toHaveBeenCalledWith({ terminalCode: 'W', displayName: 'Caisse W' })
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
    expect(screen.getByRole('button', { name: 'Configurer Caisse W' })).toHaveTextContent('Code W')
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
      screen.queryByRole('dialog', { name: 'Paramètres de la caisse' }),
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))
    expect(
      await screen.findByRole('dialog', { name: 'Paramètres de la caisse' }),
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
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clôture et sauvegarde' }))

    expect(screen.getByRole('dialog', { name: 'Mode responsable' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Clôture et sauvegarde' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))

    expect(await screen.findByRole('dialog', { name: 'Clôture et sauvegarde' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(responsibleMode.isUnlocked()).toBe(false)
  })

  it('ouvre Administration → Produits et reverrouille le mode responsable à la fermeture', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')
    await responsibleMode.unlock('4826')
    const repository = new IndexedDbCatalogRepository(new IDBFactory(), 'app-admin')
    await repository.initialize(initialCatalogProducts)

    render(
      <App
        responsibleMode={responsibleMode}
        catalogService={new CatalogService(repository, initialCatalogProducts)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Administration' }))

    const administration = await screen.findByRole('dialog', { name: 'Produits' })
    expect(within(administration).getByText('Administration')).toBeInTheDocument()
    fireEvent.click(within(administration).getByRole('button', { name: 'Fermer' }))
    expect(responsibleMode.isUnlocked()).toBe(false)
  })

  it('protège le suivi par PIN puis ouvre les paramètres existants de reconnexion', async () => {
    const mode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await mode.setupPin('4826', '4826')
    mode.lock()
    const read = vi.spyOn(synchronizationService, 'diagnostics').mockResolvedValue({
      enabled: true,
      authentication: 'session_expired',
      pendingEvents: 5,
      pending: 4,
      sending: 0,
      errors: 1,
      continuity: 'unknown',
      backfillComplete: true,
      lastSuccessAt: null,
      lastServerReceivedAt: null,
      lastExchangeAt: null,
      lastError: 'AUTH_REQUIRED',
      errorCategory: 'authentication',
    })
    const repository = new IndexedDbCatalogRepository(new IDBFactory(), 'app-sync-admin')
    render(
      <App
        responsibleMode={mode}
        catalogService={new CatalogService(repository, initialCatalogProducts)}
        loadRecoverableOrders={async () => []}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Administration' }))
    expect(read).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('region', { name: 'Synchronisation des données' }),
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Synchronisation des données' }))
    await screen.findByRole('heading', { name: 'Session de synchronisation expirée' })
    fireEvent.click(screen.getByRole('button', { name: 'Paramètres de synchronisation' }))
    expect(screen.getByRole('dialog', { name: 'Paramètres de la caisse' })).toBeInTheDocument()
    expect(mode.isUnlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(mode.isUnlocked()).toBe(false)
  })

  it('laisse enregistrer et imprimer une vente après une panne du suivi distant', async () => {
    const mode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await mode.setupPin('4826', '4826')
    vi.spyOn(synchronizationService, 'diagnostics').mockRejectedValue(
      new Error('service inaccessible'),
    )
    const retry = vi.spyOn(synchronizationService, 'retry')
    const orderRepository = new IndexedDbOrderRepository(new IDBFactory())
    const terminal = new LocalStorageTerminalConfigurationRepository(localStorage).get()!
    const checkout = new CheckoutService(orderRepository, undefined, () => terminal)
    const lifecycle = new OrderService(orderRepository, undefined, () => terminal)
    const printOrder = vi.fn().mockResolvedValue({
      ...printSuccess,
      completedDocuments: ['pickupTicket', 'preparationTicket'],
    })
    const repository = new IndexedDbCatalogRepository(new IDBFactory(), 'app-sync-outage')
    const catalog = new CatalogService(repository, witchesCatalogProducts)
    await catalog.loadCatalog()
    render(
      <App
        initialCatalog={undefined}
        initialCategories={undefined}
        responsibleMode={mode}
        catalogService={catalog}
        loadRecoverableOrders={async () => []}
        checkoutDependencies={{ checkout, lifecycle, printOrder }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Administration' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Synchronisation des données' }))
    await screen.findByRole('heading', { name: 'Suivi non disponible' })
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    fireEvent.click(await screen.findByRole('button', { name: /Potions/ }))
    fireEvent.click(screen.getByRole('button', { name: /Chocolat chaud magique, 3,00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Préparer le paiement TPE' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Paiement TPE accepté' }))
    await screen.findByRole('heading', { name: 'Commande validée' })
    expect(await lifecycle.getOrders()).toHaveLength(1)
    expect((await lifecycle.getOrders())[0]).toMatchObject({
      paymentStatus: 'paid',
      printing: { status: 'printed' },
    })
    expect(
      (await orderRepository.getLedgerEntries()).filter((entry) => entry.kind === 'sale'),
    ).toHaveLength(1)
    expect(printOrder).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    await orderRepository.close()
  })

  it.each(['panier', 'options', 'paiement', 'repos'] as const)(
    'protège la caisse lors d’une activation distante : %s',
    async (operation) => {
      const repository = new IndexedDbCatalogRepository(new IDBFactory(), `app-sync-${operation}`)
      const service = new CatalogService(repository, witchesCatalogProducts)
      await service.loadCatalog()
      const remote = witchesCatalogProducts.map((product) => ({
        ...product,
        dataConfidence: 'confirmed',
        ...(product.id === 'chocolat-chaud-magique' ? { priceCents: 400 } : {}),
        variants: product.variants?.map((variant) => ({ ...variant, dataConfidence: 'confirmed' })),
      }))
      const scope = {
        organizationId: '00000000-0000-0000-0000-000000000001',
        festivalId: '10000000-0000-0000-0000-000000000001',
      }
      const payload = JSON.stringify({
        ...scope,
        id: 'publication',
        revision: 1,
        schemaVersion: 1,
        publishedAt: '2026-10-21T10:00:00Z',
        origin: 'supabase:fixture',
        products: remote,
        categories: witchesCategories,
      })
      await service.distribution.stage({ payload, sha256: sha256Hex(payload) }, scope)
      const responsibleMode = new ResponsibleModeService(
        new LocalStorageResponsibleCredentialRepository(localStorage),
      )
      await responsibleMode.setupPin('4826', '4826')
      await responsibleMode.unlock('4826')
      const loadRecoverableOrders = vi.fn(async () => [])
      render(
        <App
          initialCatalog={undefined}
          initialCategories={undefined}
          catalogService={service}
          responsibleMode={responsibleMode}
          loadRecoverableOrders={loadRecoverableOrders}
        />,
      )
      await screen.findByRole('button', { name: /Matcha au lait végétal/ })
      await waitFor(() => expect(loadRecoverableOrders).toHaveBeenCalled())
      if (operation === 'options')
        fireEvent.click(screen.getByRole('button', { name: /Matcha au lait végétal/ }))
      if (operation === 'panier' || operation === 'paiement') {
        fireEvent.click(screen.getByRole('button', { name: 'Potions' }))
        fireEvent.click(screen.getByRole('button', { name: /Chocolat chaud magique, 3,00/ }))
      }
      if (operation === 'paiement')
        fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
      const before = structuredClone(useCartStore.getState().items)
      fireEvent.click(screen.getByRole('button', { name: 'Administration' }))
      const admin = await screen.findByRole('dialog', { name: 'Produits' })
      fireEvent.click(within(admin).getByRole('button', { name: 'Catalogue partagé' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Activer la version téléchargée' }))
      if (operation === 'repos') {
        await waitFor(async () =>
          expect((await service.distribution.status()).active).toBeDefined(),
        )
        expect(
          (await service.getProducts()).find(({ id }) => id === 'chocolat-chaud-magique')
            ?.priceCents,
        ).toBe(400)
      } else {
        expect(await screen.findByRole('alert')).toHaveTextContent('Terminez')
        expect((await service.distribution.status()).active).toBeUndefined()
        expect(
          (await service.getProducts()).find(({ id }) => id === 'chocolat-chaud-magique')
            ?.priceCents,
        ).toBe(300)
        expect(useCartStore.getState().items).toEqual(before)
        if (operation === 'options')
          expect(screen.getByRole('dialog', { name: 'Matcha au lait végétal' })).toBeInTheDocument()
        if (operation === 'paiement')
          expect(screen.getByRole('dialog', { name: 'Encaissement' })).toBeInTheDocument()
      }
    },
  )

  it('protège les catégories et conserve la caisse même sans catégorie active', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')
    responsibleMode.lock()
    const service = new CatalogService(
      new IndexedDbCatalogRepository(new IDBFactory(), 'app-categories'),
    )
    await service.loadCatalog()
    for (const category of await service.getCategories()) {
      if (!['potions', 'gourmandises'].includes(category.id))
        await service.setCategoryActive(category.id, false)
    }
    useCartStore
      .getState()
      .addItem(
        createCartItemDraft(witchesCatalogProducts.find(({ id }) => id === 'cookie-ensorcele')!),
      )
    const cartBefore = structuredClone(useCartStore.getState().items)
    render(
      <App
        initialCatalog={undefined}
        initialCategories={undefined}
        catalogService={service}
        responsibleMode={responsibleMode}
        loadRecoverableOrders={vi.fn(async () => [])}
      />,
    )
    const navigation = await screen.findByRole('navigation', { name: 'Catégories de produits' })
    await waitFor(() =>
      expect(within(navigation).getByRole('button', { name: 'Potions' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Administration' }))
    expect(await screen.findByRole('dialog', { name: 'Mode responsable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Catégories' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN responsable'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Catégories' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une catégorie' }))
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), { target: { value: 'Du jour' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByRole('listitem', { name: 'Du jour' })
    expect(within(navigation).getByRole('button', { name: 'Du jour' })).toBeInTheDocument()
    fireEvent.click(
      within(screen.getByRole('listitem', { name: 'Potions' })).getByRole('button', {
        name: 'Désactiver',
      }),
    )
    await waitFor(() =>
      expect(within(navigation).queryByRole('button', { name: 'Potions' })).not.toBeInTheDocument(),
    )
    expect(within(navigation).getByRole('button', { name: 'Gourmandises' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(
      within(screen.getByRole('listitem', { name: 'Gourmandises' })).getByRole('button', {
        name: 'Renommer',
      }),
    )
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), {
      target: { value: 'Douceurs' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(within(navigation).getByRole('button', { name: 'Douceurs' })).toBeInTheDocument(),
    )
    for (const name of ['Douceurs', 'Du jour']) {
      fireEvent.click(
        within(screen.getByRole('listitem', { name })).getByRole('button', { name: 'Désactiver' }),
      )
      await waitFor(() =>
        expect(within(navigation).queryByRole('button', { name })).not.toBeInTheDocument(),
      )
    }
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.getByText(/Aucune catégorie active/)).toBeInTheDocument()
    expect(useCartStore.getState().items).toEqual(cartBefore)
    expect(screen.getByRole('button', { name: /Valider la commande/ })).toBeInTheDocument()
    expect(responsibleMode.isUnlocked()).toBe(false)
  })

  it('bloque le reprovisionnement tant que la session de caisse est ouverte', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    await responsibleMode.setupPin('4826', '4826')

    render(<App responsibleMode={responsibleMode} loadRecoverableOrders={vi.fn(async () => [])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configurer Caisse A' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Changer la caisse utilisée' })).toBeDisabled(),
    )
    expect(screen.getByText(/Clôturez la session de caisse/)).toBeInTheDocument()
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

    expect(await screen.findByRole('button', { name: 'Changer la caisse utilisée' })).toBeDisabled()
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
    expect(screen.queryByText('Imprimante : Connectée')).not.toBeInTheDocument()

    finishProbe?.('ready')
    expect(await screen.findByText('Imprimante : Connectée')).toBeInTheDocument()
  })

  it('ouvre la configuration USB depuis le statut imprimante et revient à la caisse', async () => {
    render(<App probePrinterStatus={async () => 'disconnected'} />)
    await screen.findByText('Imprimante : Non détectée')

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Configurer l’imprimante. Statut : Non détectée',
      }),
    )

    expect(screen.getByRole('dialog', { name: 'Imprimante' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Imprimante' })).not.toBeInTheDocument(),
    )
  })

  it('reflète une déconnexion détectée lors de la vérification suivante', async () => {
    vi.useFakeTimers()
    const probePrinterStatus = vi
      .fn<() => Promise<'ready' | 'disconnected'>>()
      .mockResolvedValueOnce('ready')
      .mockResolvedValue('disconnected')

    render(<App probePrinterStatus={probePrinterStatus} />)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Connectée')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() =>
      expect(screen.getByText('Imprimante : Non détectée')).toBeInTheDocument(),
    )
  })

  it('suit le retrait puis le retour du papier sans recharger l’application', async () => {
    vi.useFakeTimers()
    const probePrinterStatus = vi
      .fn<() => Promise<'ready' | 'paper-out'>>()
      .mockResolvedValueOnce('ready')
      .mockResolvedValueOnce('paper-out')
      .mockResolvedValue('ready')

    render(<App probePrinterStatus={probePrinterStatus} />)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Connectée')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() =>
      expect(screen.getByText('Imprimante : Plus de papier')).toBeInTheDocument(),
    )

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Connectée')).toBeInTheDocument())
  })

  it('affiche une erreur si la vérification matérielle échoue', async () => {
    render(<App probePrinterStatus={async () => 'error'} />)

    expect(await screen.findByText('Imprimante : À vérifier')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Connectée')).not.toBeInTheDocument()
  })

  it('indique clairement un capot ouvert', async () => {
    render(<App probePrinterStatus={async () => 'cover-open'} />)

    expect(await screen.findByText('Imprimante : Capot ouvert')).toBeInTheDocument()
  })

  it('n’annonce pas prête si la sonde ne peut pas lire le statut', async () => {
    render(<App probePrinterStatus={async () => Promise.reject(new Error('USB indisponible'))} />)

    expect(await screen.findByText('Imprimante : État non vérifié')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Connectée')).not.toBeInTheDocument()
  })

  it('ajoute un produit simple en un appui puis modifie sa quantité', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    expect(screen.queryByRole('dialog', { name: 'Omelette' })).not.toBeInTheDocument()
    const quantity = screen.getByLabelText('Quantité Omelette')
    expect(quantity).toBeInTheDocument()
    fireEvent.click(within(quantity).getByRole('button', { name: 'Augmenter Omelette' }))
    expect(within(quantity).getByText('2')).toBeInTheDocument()
  })

  it('ne propose pas un produit désactivé à la caisse', () => {
    const catalog = initialCatalogProducts.map((product) =>
      product.id === 'omelette' ? { ...product, active: false } : product,
    )
    render(<App initialCatalog={catalog} />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    expect(screen.queryByRole('button', { name: /Omelette/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Burger spécial Samhain/ })).toBeInTheDocument()
  })

  it('ajoute directement le Burger spécial Samhain sans proposer de personnalisation', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    expect(screen.getByText('Steak haché, cheddar, bacon, salade, sauce · frites')).toBeVisible()
    const burger = screen.getByRole('button', { name: /Burger spécial Samhain, 16,00/ })
    fireEvent.click(burger)

    expect(screen.queryByRole('dialog', { name: 'Burger spécial Samhain' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Cheddar' })).not.toBeInTheDocument()
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(screen.getAllByText('Burger spécial Samhain')).toHaveLength(2)
    expect(useCartStore.getState().items[0]?.removedIngredientIds).toEqual([])
    expect(screen.queryByText('Modifier la composition')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Personnaliser Burger spécial Samhain' }),
    ).not.toBeInTheDocument()
  })

  it('propose et ajoute directement les softs servis au verre en 33 cl', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Sans alcool/ }))
    expect(screen.getByRole('button', { name: /Oasis, 3,00/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Coca-Cola, 3,00/ }))
    expect(screen.getAllByText('Coca-Cola')).toHaveLength(2)
    expect(screen.queryByRole('dialog', { name: 'Coca-Cola' })).not.toBeInTheDocument()
  })

  it('compose un menu enfant puis ouvre l’encaissement', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Menu enfant/ }))
    expect(screen.getByRole('button', { name: /Crêpe chocolat/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Crêpe au sucre/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Crêpe caramel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Panini chocolat/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Compote|Glace/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Steak haché avec frites/ }))
    fireEvent.click(screen.getByRole('button', { name: /Panini chocolat/ }))
    fireEvent.click(screen.getByRole('button', { name: /Jus de fruit/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Menu enfant' }))
    expect(screen.getByText('Dessert : Panini chocolat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
    expect(screen.getByRole('dialog', { name: 'Encaissement' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Mode responsable/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Carte bancaire' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Préparer l’encaissement' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Valider le paiement' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Montant exact/ }))
    expect(screen.getByRole('button', { name: 'Valider le paiement' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Imprimer le ticket de caisse' })).not.toBeChecked()
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

  it('ferme la confirmation d’annulation au clic extérieur sans vider le panier', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la commande' }))

    fireEvent.click(screen.getByRole('dialog', { name: 'Annuler cette commande ?' }))

    expect(
      screen.queryByRole('dialog', { name: 'Annuler cette commande ?' }),
    ).not.toBeInTheDocument()
    expect(
      within(screen.getByLabelText('Commande en cours')).getByText('Omelette'),
    ).toBeInTheDocument()
  })

  it('abandonne les personnalisations non validées au clic extérieur', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Menu enfant/ }))
    fireEvent.click(screen.getByRole('button', { name: /Steak haché avec frites/ }))

    fireEvent.click(screen.getByRole('dialog', { name: 'Menu enfant' }))

    expect(screen.queryByRole('dialog', { name: 'Menu enfant' })).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Imprimer le ticket de caisse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Encaisser' }))

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
      fireEvent.click(screen.getByRole('checkbox', { name: 'Imprimer le ticket de caisse' }))
      fireEvent.click(screen.getByRole('button', { name: 'Carte bancaire' }))
      fireEvent.click(screen.getByRole('button', { name: 'Encaisser' }))
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
