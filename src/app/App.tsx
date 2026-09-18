import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Button } from '../components/ui/Button'
import { CartPanel } from '../features/cart/CartPanel'
import { CategoryTabs } from '../features/catalog/CategoryTabs'
import { ProductGrid } from '../features/catalog/ProductGrid'
import { ProductOptionsSheet } from '../features/catalog/ProductOptionsSheet'
import { ProductManagementDialog } from '../features/catalog/ProductManagementDialog'
import { CheckoutFlow } from '../features/checkout/CheckoutFlow'
import { DevPanel } from '../features/dev/DevPanel'
import { OrderHistory } from '../features/orders/OrderHistory'
import { PrinterConfigurationDialog } from '../features/printer/PrinterConfigurationDialog'
import { LedgerManagement, type LedgerManagementProps } from '../features/ledger/LedgerManagement'
import { ResponsibleModeDialog } from '../features/responsible/ResponsibleModeDialog'
import { SystemStatus } from '../features/status/SystemStatus'
import { TerminalConfigurationDialog } from '../features/terminal/TerminalConfigurationDialog'
import { usePrinterStatus, type PrinterStatusProbe } from '../features/status/usePrinterStatus'
import { shouldEnableDevPanel } from '../config/buildMode'
import { getCatalogService, type CatalogService } from '../services/catalogService'
import { getPersistedOrders, getRecoverableOrders } from '../services/orderService'
import { checkoutService } from '../services/checkoutService'
import { getResponsibleModeService, type ResponsibleMode } from '../services/responsibleModeService'
import { hasPendingTabletReplacement } from '../services/tabletReplacementService'
import {
  getTerminalConfiguration,
  provisionTerminal,
  renameTerminal,
  reprovisionTerminal,
} from '../services/terminalConfigurationService'
import { useCartStore } from '../store/cartStore'
import type { CategoryId, Product, ProductSelection } from '../types/catalog'
import type { CheckoutIntent } from '../types/checkout'
import type { Order } from '../types/order'
import type { PrinterStatus } from '../types/system'
import type { TerminalConfiguration, TerminalProvisioningInput } from '../types/terminal'
import { createCartItemDraft, requiresProductConfiguration } from '../utils/cart'
import { formatMoney } from '../utils/money'

type Props = {
  loadRecoverableOrders?: typeof getRecoverableOrders
  loadOrders?: typeof getPersistedOrders
  loadRecoverableIntents?: typeof checkoutService.getRecoverableIntents
  probePrinterStatus?: PrinterStatusProbe
  terminalManagement?: {
    load: () => TerminalConfiguration | null
    provision: (input: TerminalProvisioningInput) => TerminalConfiguration
    rename: (displayName: string) => TerminalConfiguration
    reprovision: (input: TerminalProvisioningInput) => TerminalConfiguration
  }
  responsibleMode?: ResponsibleMode
  loadPendingTabletReplacement?: () => boolean
  checkoutDependencies?: Pick<
    ComponentProps<typeof CheckoutFlow>,
    'createOrder' | 'checkout' | 'lifecycle' | 'printOrder'
  >
  ledgerManagementDependencies?: Pick<LedgerManagementProps, 'ledgerService' | 'now'>
  catalogService?: CatalogService
  initialCatalog?: Product[]
}

const defaultTerminalManagement = {
  load: getTerminalConfiguration,
  provision: provisionTerminal,
  rename: renameTerminal,
  reprovision: reprovisionTerminal,
}

export function App({
  loadRecoverableOrders = getRecoverableOrders,
  loadOrders = getPersistedOrders,
  loadRecoverableIntents,
  probePrinterStatus,
  terminalManagement = defaultTerminalManagement,
  responsibleMode = getResponsibleModeService(),
  loadPendingTabletReplacement = hasPendingTabletReplacement,
  checkoutDependencies,
  ledgerManagementDependencies,
  catalogService,
  initialCatalog,
}: Props = {}) {
  const catalogManagement = useMemo(
    () => catalogService ?? (initialCatalog ? null : getCatalogService()),
    [catalogService, initialCatalog],
  )
  const [products, setProducts] = useState<Product[]>(() => initialCatalog ?? [])
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>(
    initialCatalog ? 'ready' : 'loading',
  )
  const [category, setCategory] = useState<CategoryId>('menus')
  const [optionsProduct, setOptionsProduct] = useState<Product | null>(null)
  const [lastAddedProductId, setLastAddedProductId] = useState<string | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [ledgerManagementOpen, setLedgerManagementOpen] = useState(false)
  const [productManagementOpen, setProductManagementOpen] = useState(false)
  const [terminalState, setTerminalState] = useState<{
    configuration: TerminalConfiguration | null
    error: boolean
  }>(() => {
    try {
      return { configuration: terminalManagement.load(), error: false }
    } catch {
      return { configuration: null, error: true }
    }
  })
  const [terminalConfigurationOpen, setTerminalConfigurationOpen] = useState(false)
  const [responsibleRequest, setResponsibleRequest] = useState<{
    requireSetup: boolean
    resolve?: (authorized: boolean) => void
  } | null>(null)
  const terminalConfiguration = terminalState.configuration
  const terminalConfigurationError = terminalState.error
  const setTerminalConfiguration = (configuration: TerminalConfiguration) =>
    setTerminalState({ configuration, error: false })
  const [recoveryOrders, setRecoveryOrders] = useState<Order[]>([])
  const [recoveryIntents, setRecoveryIntents] = useState<CheckoutIntent[]>([])
  const [resumingOrder, setResumingOrder] = useState<Order | null>(null)
  const [resumingIntent, setResumingIntent] = useState<CheckoutIntent | null>(null)
  const [recoveryError, setRecoveryError] = useState(false)
  const [recoveryCheckedTerminalId, setRecoveryCheckedTerminalId] = useState<string | null>(null)
  const [tabletReplacementPending] = useState(() => {
    try {
      return loadPendingTabletReplacement()
    } catch {
      return true
    }
  })
  const [printerOverride, setPrinterOverride] = useState<PrinterStatus | null>(null)
  const [printerConfigurationOpen, setPrinterConfigurationOpen] = useState(false)
  const { status: realPrinterStatus, refresh: refreshPrinterStatus } =
    usePrinterStatus(probePrinterStatus)
  const devPanelEnabled = shouldEnableDevPanel(import.meta.env)
  const printer = devPanelEnabled && printerOverride ? printerOverride : realPrinterStatus
  const feedbackTimer = useRef<number | null>(null)
  const items = useCartStore((state) => state.items)
  const addItem = useCartStore((state) => state.addItem)
  const clearCart = useCartStore((state) => state.clearCart)
  const recoverableIntentLoader = useMemo(
    () =>
      loadRecoverableIntents ??
      (loadRecoverableOrders === getRecoverableOrders
        ? checkoutService.getRecoverableIntents
        : async () => [] as CheckoutIntent[]),
    [loadRecoverableIntents, loadRecoverableOrders],
  )

  useEffect(() => {
    if (initialCatalog || !catalogManagement) return
    let active = true
    void catalogManagement.loadCatalog().then(
      (loadedProducts) => {
        if (!active) return
        setProducts(loadedProducts)
        setCatalogStatus('ready')
      },
      () => {
        if (active) setCatalogStatus('error')
      },
    )
    return () => {
      active = false
    }
  }, [catalogManagement, initialCatalog])

  const requestResponsibleAccess = useCallback((): Promise<boolean> => {
    try {
      responsibleMode.requireUnlocked()
      return Promise.resolve(true)
    } catch {
      return new Promise((resolve) => {
        setResponsibleRequest({ requireSetup: false, resolve })
      })
    }
  }, [responsibleMode])

  useEffect(() => {
    const lockWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        responsibleMode.lock()
        setTerminalConfigurationOpen(false)
        setLedgerManagementOpen(false)
        setPrinterConfigurationOpen(false)
        setProductManagementOpen(false)
      }
    }
    document.addEventListener('visibilitychange', lockWhenHidden)
    return () => document.removeEventListener('visibilitychange', lockWhenHidden)
  }, [responsibleMode])

  useEffect(() => {
    if (!terminalConfiguration) return
    let active = true
    void (async () => {
      try {
        const [orders, intents] = await Promise.all([
          loadRecoverableOrders(),
          recoverableIntentLoader(),
        ])
        if (active) {
          setRecoveryOrders(orders)
          setRecoveryIntents(intents)
          setRecoveryError(false)
          setRecoveryCheckedTerminalId(terminalConfiguration.terminalId)
        }
      } catch {
        if (active) {
          setRecoveryError(true)
          setRecoveryCheckedTerminalId(terminalConfiguration.terminalId)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [loadRecoverableOrders, recoverableIntentLoader, terminalConfiguration])

  const filteredProducts = useMemo(
    () =>
      products.filter(
        (product) =>
          product.active && product.availability === 'available' && product.categoryId === category,
      ),
    [category, products],
  )

  const showAddedFeedback = (productId: string) => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    setLastAddedProductId(productId)
    feedbackTimer.current = window.setTimeout(() => setLastAddedProductId(null), 650)
  }

  const addConfiguredProduct = (
    product: Product,
    selection: ProductSelection,
    removedIngredientIds: string[] = [],
  ) => {
    addItem(createCartItemDraft(product, selection, removedIngredientIds))
    showAddedFeedback(product.id)
  }

  const selectProduct = (product: Product) => {
    if (product.availability !== 'available') return
    if (requiresProductConfiguration(product)) {
      setOptionsProduct(product)
      return
    }
    addConfiguredProduct(product, {
      variantId: product.variants?.[0]?.id,
      optionIdsByGroup: {},
    })
  }

  const validateOrder = () => {
    if (!items.length) return
    setCheckoutOpen(true)
  }

  const startNewOrder = () => {
    if (!resumingOrder && !resumingIntent) clearCart()
    setCheckoutOpen(false)
    setResumingOrder(null)
    setResumingIntent(null)
    setCategory('menus')
  }

  const updateRecoveryOrder = (updatedOrder: Order) => {
    setRecoveryOrders((orders) => {
      if (updatedOrder.printing.status === 'printed') {
        return orders.filter((order) => order.id !== updatedOrder.id)
      }
      const exists = orders.some((order) => order.id === updatedOrder.id)
      const updatedOrders = exists
        ? orders.map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
        : [...orders, updatedOrder]
      return updatedOrders.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    })
    if (resumingOrder?.id === updatedOrder.id) setResumingOrder(updatedOrder)
  }

  const updateRecoveryIntent = (updatedIntent: CheckoutIntent) => {
    setRecoveryIntents((intents) => {
      if (['finalized', 'abandoned'].includes(updatedIntent.status)) {
        return intents.filter((intent) => intent.id !== updatedIntent.id)
      }
      const exists = intents.some((intent) => intent.id === updatedIntent.id)
      const updated = exists
        ? intents.map((intent) => (intent.id === updatedIntent.id ? updatedIntent : intent))
        : [...intents, updatedIntent]
      return updated.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    })
    if (resumingIntent?.id === updatedIntent.id) setResumingIntent(updatedIntent)
  }

  const recoveryCheckPending = Boolean(
    terminalConfiguration && recoveryCheckedTerminalId !== terminalConfiguration.terminalId,
  )
  const reprovisioningBlockReason = recoveryCheckPending
    ? 'Impossible de changer la caisse tant que la vérification des opérations en attente n’est pas terminée.'
    : recoveryError
      ? 'Impossible de changer la caisse car les impressions à reprendre n’ont pas pu être vérifiées.'
      : recoveryOrders.length > 0 || recoveryIntents.length > 0
        ? 'Impossible de changer la caisse tant que des encaissements ou impressions sont à reprendre.'
        : null

  if (tabletReplacementPending) {
    return (
      <main className="flex h-dvh items-center justify-center bg-[#f2eee5] p-6">
        <p
          className="max-w-xl border border-amber-400 bg-amber-50 p-5 font-bold text-amber-950"
          role="alert"
        >
          Un remplacement de tablette a été interrompu. Reprenez la procédure avec la même
          sauvegarde Samhain. La configuration et l’encaissement restent bloqués jusque-là.
        </p>
      </main>
    )
  }

  if (terminalConfigurationError) {
    return (
      <main className="flex h-dvh items-center justify-center bg-[#f2eee5] p-6">
        <p
          className="max-w-xl border border-rose-300 bg-rose-50 p-5 font-bold text-rose-950"
          role="alert"
        >
          Impossible d’ouvrir les données enregistrées sur cette tablette. Aucun encaissement n’est
          possible. Redémarrez l’application, puis réessayez.
        </p>
      </main>
    )
  }

  if (terminalConfiguration === null) {
    return (
      <TerminalConfigurationDialog
        configuration={null}
        onProvision={terminalManagement.provision}
        onRename={terminalManagement.rename}
        onReprovision={terminalManagement.reprovision}
        onConfigured={(configuration) => {
          setTerminalConfiguration(configuration)
          if (!responsibleMode.hasCredential()) {
            setResponsibleRequest({ requireSetup: true })
          }
        }}
      />
    )
  }

  return (
    <div className="flex h-dvh min-h-[600px] flex-col bg-[#f2eee5] text-stone-950">
      <header className="flex min-h-16 items-center justify-between gap-4 bg-[#18231e] px-5 py-2 text-white">
        <div className="flex items-baseline gap-3">
          <div className="text-xl font-black">Samhain POS</div>
          <button
            type="button"
            className="min-h-11 border-l border-stone-600 pl-3 text-left text-sm font-bold text-stone-200 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white"
            aria-label={`Configurer ${terminalConfiguration.displayName}`}
            onClick={() => {
              void requestResponsibleAccess().then((authorized) => {
                if (authorized) setTerminalConfigurationOpen(true)
              })
            }}
          >
            {terminalConfiguration.displayName}
            <span className="block text-xs text-stone-400">
              Code {terminalConfiguration.terminalCode}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="headerSecondary"
            className="min-h-11 px-4 py-2"
            onClick={() => {
              void requestResponsibleAccess().then((authorized) => {
                if (authorized) setProductManagementOpen(true)
              })
            }}
          >
            Administration
          </Button>
          <Button
            variant="headerImportant"
            className="min-h-11 px-4 py-2"
            onClick={() => {
              void requestResponsibleAccess().then((authorized) => {
                if (authorized) setLedgerManagementOpen(true)
              })
            }}
          >
            Clôture et sauvegarde
          </Button>
          <Button
            variant="headerSecondary"
            className="min-h-11 px-4 py-2"
            onClick={() => setHistoryOpen(true)}
          >
            Historique
          </Button>
          <SystemStatus
            printer={printer}
            onPrinterClick={() => setPrinterConfigurationOpen(true)}
          />
        </div>
      </header>

      {recoveryError ? (
        <div
          className="border-b border-rose-300 bg-rose-50 px-5 py-3 font-bold text-rose-950"
          role="alert"
        >
          Impossible de vérifier les opérations en attente. Redémarrez l’application avant
          d’encaisser.
        </div>
      ) : recoveryIntents.length ? (
        <div className="flex items-center justify-between gap-4 border-b border-rose-300 bg-rose-50 px-5 py-3 text-rose-950">
          <div>
            <p className="font-black">{recoveryIntents.length} encaissement(s) à vérifier</p>
            <p className="text-sm font-bold">
              {recoveryIntents[0]?.totalCents !== undefined
                ? `${formatMoney(recoveryIntents[0].totalCents)} · ${recoveryIntents[0].paymentMethod === 'card' ? 'Carte bancaire' : 'Espèces'} · vérifiez le paiement avant de continuer`
                : 'Une action du caissier est nécessaire'}
            </p>
          </div>
          <Button
            onClick={() => {
              setResumingIntent(recoveryIntents[0] ?? null)
              setCheckoutOpen(true)
            }}
          >
            Vérifier le paiement
          </Button>
        </div>
      ) : recoveryOrders.length ? (
        <div className="flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-50 px-5 py-3 text-amber-950">
          <div>
            <p className="font-black">{recoveryOrders.length} impression(s) à reprendre</p>
            <p className="text-sm font-bold">
              Commande {recoveryOrders[0]?.orderNumber} payée et enregistrée
            </p>
          </div>
          <Button
            onClick={() => {
              setResumingOrder(recoveryOrders[0] ?? null)
              setCheckoutOpen(true)
            }}
          >
            Reprendre l’impression
          </Button>
        </div>
      ) : null}

      {devPanelEnabled ? (
        <DevPanel
          products={products.filter((product) => product.active)}
          printerOverride={printerOverride}
          onPrinterOverride={setPrinterOverride}
        />
      ) : null}

      <main className="pos-layout min-h-0 flex-1">
        <aside className="category-zone border-b border-stone-300 bg-[#e9e2d5] lg:border-r lg:border-b-0">
          <CategoryTabs activeCategory={category} onChange={setCategory} />
        </aside>
        <section
          className="catalog-zone min-h-0 overflow-y-auto p-4"
          aria-label="Catalogue produits"
        >
          <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-stone-300 pb-3">
            <h1 className="text-2xl font-black">{productCategoriesLabel(category)}</h1>
            <span className="text-sm font-bold text-stone-600">Touchez pour ajouter</span>
          </div>
          <ProductGrid
            products={filteredProducts}
            onSelect={selectProduct}
            lastAddedProductId={lastAddedProductId}
            status={catalogStatus}
            errorMessage="Le catalogue est momentanément indisponible. Redémarrez l’application, puis réessayez."
          />
        </section>
        <CartPanel onCheckout={validateOrder} products={products} />
      </main>

      {optionsProduct ? (
        <ProductOptionsSheet
          product={optionsProduct}
          onCancel={() => setOptionsProduct(null)}
          onConfirm={(selection, removedIngredientIds) => {
            addConfiguredProduct(optionsProduct, selection, removedIngredientIds)
            setOptionsProduct(null)
          }}
        />
      ) : null}

      {checkoutOpen ? (
        <CheckoutFlow
          items={resumingOrder?.items ?? items}
          onCancel={() => setCheckoutOpen(false)}
          onNewOrder={startNewOrder}
          initialOrder={resumingOrder ?? undefined}
          initialIntent={resumingIntent ?? undefined}
          onOrderUpdated={updateRecoveryOrder}
          onIntentUpdated={updateRecoveryIntent}
          requestResponsibleAccess={requestResponsibleAccess}
          {...checkoutDependencies}
        />
      ) : null}

      {historyOpen ? (
        <OrderHistory
          onClose={() => {
            setHistoryOpen(false)
            responsibleMode.lock()
          }}
          loadOrders={loadOrders}
          products={products}
          onOrderUpdated={updateRecoveryOrder}
          requestResponsibleAccess={requestResponsibleAccess}
        />
      ) : null}

      {terminalConfigurationOpen ? (
        <TerminalConfigurationDialog
          configuration={terminalConfiguration}
          onProvision={terminalManagement.provision}
          onRename={terminalManagement.rename}
          onReprovision={terminalManagement.reprovision}
          onConfigured={(configuration) => {
            setTerminalConfiguration(configuration)
            setTerminalConfigurationOpen(false)
            responsibleMode.lock()
          }}
          reprovisioningBlockReason={reprovisioningBlockReason}
          onClose={() => {
            setTerminalConfigurationOpen(false)
            responsibleMode.lock()
          }}
        />
      ) : null}

      {productManagementOpen && catalogManagement ? (
        <ProductManagementDialog
          products={products}
          service={catalogManagement}
          onProductsChanged={(updatedProducts) => {
            setProducts(updatedProducts)
            setCatalogStatus('ready')
          }}
          onClose={() => {
            setProductManagementOpen(false)
            responsibleMode.lock()
          }}
        />
      ) : null}

      {ledgerManagementOpen ? (
        <LedgerManagement
          onClose={() => {
            setLedgerManagementOpen(false)
            responsibleMode.lock()
          }}
          {...ledgerManagementDependencies}
        />
      ) : null}

      {printerConfigurationOpen ? (
        <PrinterConfigurationDialog
          initialStatus={realPrinterStatus}
          onStatusChanged={refreshPrinterStatus}
          onClose={() => {
            setPrinterConfigurationOpen(false)
            refreshPrinterStatus()
          }}
        />
      ) : null}

      {responsibleRequest ? (
        <ResponsibleModeDialog
          responsibleMode={responsibleMode}
          requireSetup={responsibleRequest.requireSetup}
          onUnlocked={() => {
            responsibleRequest.resolve?.(true)
            setResponsibleRequest(null)
          }}
          onCancel={() => {
            responsibleRequest.resolve?.(false)
            setResponsibleRequest(null)
          }}
        />
      ) : null}
    </div>
  )
}

function productCategoriesLabel(categoryId: CategoryId): string {
  const labels: Record<CategoryId, string> = {
    menus: 'Menus',
    assiettes: 'Assiettes',
    desserts: 'Desserts',
    'boissons-chaudes': 'Boissons chaudes',
    bieres: 'Bières et cidre',
    'sans-alcool': 'Sans alcool',
  }
  return labels[categoryId]
}
