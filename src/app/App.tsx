import { useMemo, useState } from 'react'
import { CartPanel } from '../features/cart/CartPanel'
import { CategoryTabs, type CategoryFilter } from '../features/catalog/CategoryTabs'
import { ProductGrid } from '../features/catalog/ProductGrid'
import { ProductOptionsSheet } from '../features/catalog/ProductOptionsSheet'
import { CheckoutFlow, type CheckoutStep } from '../features/checkout/CheckoutFlow'
import { DevPanel } from '../features/dev/DevPanel'
import { SystemStatus } from '../features/status/SystemStatus'
import { products } from '../mocks/products'
import { getCartTotalCents, useCartStore } from '../store/cartStore'
import type { Product } from '../types/catalog'
import type { NetworkStatus, PrinterStatus } from '../types/system'

export function App() {
  const [category, setCategory] = useState<CategoryFilter>('Tout')
  const [optionsProduct, setOptionsProduct] = useState<Product | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep>('method')
  const [network, setNetwork] = useState<NetworkStatus>('online')
  const [printer, setPrinter] = useState<PrinterStatus>('ready')
  const items = useCartStore((s) => s.items)
  const addItem = useCartStore((s) => s.addItem)
  const clearCart = useCartStore((s) => s.clearCart)
  const total = getCartTotalCents(items)
  const filtered = useMemo(() => category === 'Tout' ? products : products.filter((p) => p.category === category), [category])

  const openCheckout = (step: CheckoutStep = 'method') => {
    if (useCartStore.getState().items.length === 0) {
      const demoProduct = products.find((p) => p.id === 'burger-samhain')
      if (demoProduct) addItem(demoProduct)
    }
    setCheckoutStep(step)
    setCheckoutOpen(true)
  }

  const selectProduct = (product: Product) => {
    if (product.hasOptionsPrototype) setOptionsProduct(product)
    else addItem(product)
  }

  return <div className="flex h-dvh min-h-[600px] flex-col bg-slate-100 text-slate-950">
    <header className="flex min-h-18 items-center justify-between gap-4 bg-slate-900 px-5 py-3 text-white"><div><div className="text-xs font-extrabold uppercase tracking-[0.18em] text-slate-400">Festival · POS</div><div className="text-2xl font-black">Caisse A</div></div><SystemStatus network={network} printer={printer} /></header>
    {network !== 'online' ? <div className="bg-sky-50 px-5 py-2 text-sm font-bold text-sky-950">{network === 'offline' ? 'Hors ligne — les ventes continuent sur cette tablette.' : 'Synchronisation locale simulée — aucun blocage de caisse.'}</div> : null}
    {(import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_PANEL === 'true') ? <DevPanel network={network} printer={printer} onNetwork={setNetwork} onPrinter={setPrinter} onCheckoutDemo={openCheckout} /> : null}
    <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_390px]">
      <section className="min-h-0 overflow-y-auto p-5"><div className="sticky top-0 z-10 -mx-1 mb-4 bg-slate-100 px-1 pb-3"><CategoryTabs activeCategory={category} onChange={setCategory} /></div><ProductGrid products={filtered} onSelect={selectProduct} /></section>
      <CartPanel onCheckout={() => openCheckout('method')} />
    </main>
    {optionsProduct ? <ProductOptionsSheet product={optionsProduct} onCancel={() => setOptionsProduct(null)} onConfirm={(p) => { addItem(p); setOptionsProduct(null) }} /> : null}
    {checkoutOpen ? <CheckoutFlow key={checkoutStep} initialStep={checkoutStep} totalCents={total} printer={printer} onClose={() => setCheckoutOpen(false)} onComplete={() => { clearCart(); setCheckoutOpen(false); setPrinter('ready') }} /> : null}
  </div>
}
