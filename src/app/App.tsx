import { useMemo, useRef, useState } from 'react'
import { CartPanel } from '../features/cart/CartPanel'
import { CategoryTabs } from '../features/catalog/CategoryTabs'
import { ProductGrid } from '../features/catalog/ProductGrid'
import { ProductOptionsSheet } from '../features/catalog/ProductOptionsSheet'
import { CheckoutFlow } from '../features/checkout/CheckoutFlow'
import { DevPanel } from '../features/dev/DevPanel'
import { SystemStatus } from '../features/status/SystemStatus'
import { products } from '../mocks/products'
import { useCartStore } from '../store/cartStore'
import type { CategoryId, Product, ProductSelection } from '../types/catalog'
import type { NetworkStatus, PrinterStatus } from '../types/system'
import { createCartItemDraft, requiresProductConfiguration } from '../utils/cart'

export function App() {
  const [category, setCategory] = useState<CategoryId>('menus')
  const [optionsProduct, setOptionsProduct] = useState<Product | null>(null)
  const [lastAddedProductId, setLastAddedProductId] = useState<string | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [network, setNetwork] = useState<NetworkStatus>('online')
  const [printer, setPrinter] = useState<PrinterStatus>('ready')
  const feedbackTimer = useRef<number | null>(null)
  const items = useCartStore((state) => state.items)
  const addItem = useCartStore((state) => state.addItem)
  const clearCart = useCartStore((state) => state.clearCart)

  const filteredProducts = useMemo(
    () => products.filter((product) => product.categoryId === category),
    [category],
  )

  const showAddedFeedback = (productId: string) => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    setLastAddedProductId(productId)
    feedbackTimer.current = window.setTimeout(() => setLastAddedProductId(null), 650)
  }

  const addConfiguredProduct = (product: Product, selection: ProductSelection) => {
    addItem(createCartItemDraft(product, selection))
    showAddedFeedback(product.id)
  }

  const selectProduct = (product: Product) => {
    if (product.availability !== 'available') return
    if (requiresProductConfiguration(product)) {
      setOptionsProduct(product)
      return
    }
    addConfiguredProduct(product, { variantId: product.variants?.[0]?.id, optionIds: {} })
  }

  const validateOrder = () => {
    if (!items.length) return
    setCheckoutOpen(true)
  }

  const startNewOrder = () => {
    clearCart()
    setCheckoutOpen(false)
    setCategory('menus')
  }

  return (
    <div className="flex h-dvh min-h-[600px] flex-col bg-[#f2eee5] text-stone-950">
      <header className="flex min-h-16 items-center justify-between gap-4 bg-[#18231e] px-5 py-2 text-white">
        <div className="flex items-baseline gap-3">
          <div className="text-xl font-black">Samhain POS</div>
          <div className="text-sm font-bold text-stone-300">Caisse A</div>
        </div>
        <SystemStatus network={network} printer={printer} />
      </header>

      {network !== 'online' ? (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2 text-sm font-bold text-sky-950">
          {network === 'offline'
            ? 'Hors ligne — les ventes continuent sur cette tablette.'
            : 'Synchronisation locale simulée — aucun blocage de caisse.'}
        </div>
      ) : null}

      {import.meta.env.DEV ||
      import.meta.env.MODE === 'android-test' ||
      import.meta.env.VITE_ENABLE_DEV_PANEL === 'true' ? (
        <DevPanel
          network={network}
          printer={printer}
          onNetwork={setNetwork}
          onPrinter={setPrinter}
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
        <CartPanel onCheckout={validateOrder} />
      </main>

      {optionsProduct ? (
        <ProductOptionsSheet
          product={optionsProduct}
          onCancel={() => setOptionsProduct(null)}
          onConfirm={(selection) => {
            addConfiguredProduct(optionsProduct, selection)
            setOptionsProduct(null)
          }}
        />
      ) : null}

      {checkoutOpen ? (
        <CheckoutFlow
          items={items}
          onCancel={() => setCheckoutOpen(false)}
          onNewOrder={startNewOrder}
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
