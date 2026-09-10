import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { CartPanel } from '../features/cart/CartPanel'
import { CategoryTabs } from '../features/catalog/CategoryTabs'
import { ProductGrid } from '../features/catalog/ProductGrid'
import { ProductOptionsSheet } from '../features/catalog/ProductOptionsSheet'
import { CheckoutFlow } from '../features/checkout/CheckoutFlow'
import { DevPanel } from '../features/dev/DevPanel'
import { OrderHistory } from '../features/orders/OrderHistory'
import { SystemStatus } from '../features/status/SystemStatus'
import { usePrinterStatus, type PrinterStatusProbe } from '../features/status/usePrinterStatus'
import { shouldEnableDevPanel } from '../config/buildMode'
import { products } from '../mocks/products'
import { getPersistedOrders, getRecoverableOrders } from '../services/orderService'
import { useCartStore } from '../store/cartStore'
import type { CategoryId, Product, ProductSelection } from '../types/catalog'
import type { Order } from '../types/order'
import type { NetworkStatus, PrinterStatus } from '../types/system'
import { createCartItemDraft, requiresProductConfiguration } from '../utils/cart'

type Props = {
  loadRecoverableOrders?: typeof getRecoverableOrders
  loadOrders?: typeof getPersistedOrders
  probePrinterStatus?: PrinterStatusProbe
}

export function App({
  loadRecoverableOrders = getRecoverableOrders,
  loadOrders = getPersistedOrders,
  probePrinterStatus,
}: Props = {}) {
  const [category, setCategory] = useState<CategoryId>('menus')
  const [optionsProduct, setOptionsProduct] = useState<Product | null>(null)
  const [lastAddedProductId, setLastAddedProductId] = useState<string | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [recoveryOrders, setRecoveryOrders] = useState<Order[]>([])
  const [resumingOrder, setResumingOrder] = useState<Order | null>(null)
  const [recoveryError, setRecoveryError] = useState(false)
  const [network, setNetwork] = useState<NetworkStatus>('online')
  const [printerOverride, setPrinterOverride] = useState<PrinterStatus | null>(null)
  const realPrinterStatus = usePrinterStatus(probePrinterStatus)
  const devPanelEnabled = shouldEnableDevPanel(import.meta.env)
  const printer = devPanelEnabled && printerOverride ? printerOverride : realPrinterStatus
  const feedbackTimer = useRef<number | null>(null)
  const items = useCartStore((state) => state.items)
  const addItem = useCartStore((state) => state.addItem)
  const clearCart = useCartStore((state) => state.clearCart)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const orders = await loadRecoverableOrders()
        if (active) setRecoveryOrders(orders)
      } catch {
        if (active) setRecoveryError(true)
      }
    })()
    return () => {
      active = false
    }
  }, [loadRecoverableOrders])

  const filteredProducts = useMemo(
    () => products.filter((product) => product.categoryId === category),
    [category],
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
    if (!resumingOrder) clearCart()
    setCheckoutOpen(false)
    setResumingOrder(null)
    setCategory('menus')
  }

  const updateRecoveryOrder = (updatedOrder: Order) => {
    setRecoveryOrders((orders) => {
      if (updatedOrder.printing.status === 'printed') {
        return orders.filter((order) => order.id !== updatedOrder.id)
      }
      const exists = orders.some((order) => order.id === updatedOrder.id)
      return exists
        ? orders.map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
        : [...orders, updatedOrder]
    })
    if (resumingOrder?.id === updatedOrder.id) setResumingOrder(updatedOrder)
  }

  return (
    <div className="flex h-dvh min-h-[600px] flex-col bg-[#f2eee5] text-stone-950">
      <header className="flex min-h-16 items-center justify-between gap-4 bg-[#18231e] px-5 py-2 text-white">
        <div className="flex items-baseline gap-3">
          <div className="text-xl font-black">Samhain POS</div>
          <div className="text-sm font-bold text-stone-300">Caisse A</div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            className="min-h-11 border-stone-500 bg-transparent px-4 py-2 text-white active:bg-white/10"
            onClick={() => setHistoryOpen(true)}
          >
            Historique
          </Button>
          <SystemStatus network={network} printer={printer} />
        </div>
      </header>

      {network !== 'online' ? (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2 text-sm font-bold text-sky-950">
          {network === 'offline'
            ? 'Hors ligne — les ventes continuent sur cette tablette.'
            : 'Synchronisation locale simulée — aucun blocage de caisse.'}
        </div>
      ) : null}

      {recoveryError ? (
        <div
          className="border-b border-rose-300 bg-rose-50 px-5 py-3 font-bold text-rose-950"
          role="alert"
        >
          Impossible de vérifier les impressions en attente. Redémarrez l’application avant
          d’encaisser.
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
          network={network}
          printerOverride={printerOverride}
          onNetwork={setNetwork}
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
          onOrderUpdated={updateRecoveryOrder}
        />
      ) : null}

      {historyOpen ? (
        <OrderHistory
          onClose={() => setHistoryOpen(false)}
          loadOrders={loadOrders}
          onOrderUpdated={updateRecoveryOrder}
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
