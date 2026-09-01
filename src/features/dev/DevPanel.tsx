import { Button } from '../../components/ui/Button'
import { products } from '../../mocks/products'
import { useCartStore } from '../../store/cartStore'
import type { NetworkStatus, PrinterStatus } from '../../types/system'
import type { CheckoutStep } from '../checkout/CheckoutFlow'
import { UsbPrinterPanel } from './UsbPrinterPanel'

type Props = {
  network: NetworkStatus
  printer: PrinterStatus
  onNetwork: (value: NetworkStatus) => void
  onPrinter: (value: PrinterStatus) => void
  onCheckoutDemo: (step: CheckoutStep) => void
}

export function DevPanel({ network, printer, onNetwork, onPrinter, onCheckoutDemo }: Props) {
  const clear = useCartStore((s) => s.clearCart)
  const add = useCartStore((s) => s.addItem)
  const loadBusyCart = () => {
    clear()
    products.filter((p) => p.availability === 'available').slice(0, 8).forEach((p) => add(p))
  }

  return (
    <details className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-sm">
      <summary className="cursor-pointer font-black">Outils de démonstration</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Button className="min-h-10 py-2" onClick={clear}>Panier vide</Button>
        <Button className="min-h-10 py-2" onClick={loadBusyCart}>Panier chargé</Button>
        <label className="font-bold">Réseau<select className="ml-2 min-h-10 rounded-lg border bg-white px-2" value={network} onChange={(e) => onNetwork(e.target.value as NetworkStatus)}><option value="online">En ligne</option><option value="offline">Hors ligne</option><option value="syncing">Synchronisation</option><option value="sync-error">Erreur de sync</option></select></label>
        <label className="font-bold">Imprimante<select className="ml-2 min-h-10 rounded-lg border bg-white px-2" value={printer} onChange={(e) => onPrinter(e.target.value as PrinterStatus)}><option value="ready">Prête</option><option value="printing">Impression</option><option value="disconnected">Déconnectée</option><option value="paper-out">Plus de papier</option><option value="error">Erreur</option></select></label>
        <Button className="min-h-10 py-2" onClick={() => onCheckoutDemo('card')}>Démo CB</Button>
        <Button className="min-h-10 py-2" onClick={() => onCheckoutDemo('cash')}>Démo espèces</Button>
        <Button className="min-h-10 py-2" onClick={() => onCheckoutDemo('success')}>Démo succès</Button>
      </div>
      <UsbPrinterPanel />
    </details>
  )
}
