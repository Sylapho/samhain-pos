import { Button } from '../../components/ui/Button'
import { products } from '../../mocks/products'
import { useCartStore } from '../../store/cartStore'
import type { NetworkStatus, PrinterStatus } from '../../types/system'
import { createCartItemDraft, getDefaultProductSelection } from '../../utils/cart'
import { UsbPrinterPanel } from './UsbPrinterPanel'

type Props = {
  network: NetworkStatus
  printerOverride: PrinterStatus | null
  onNetwork: (value: NetworkStatus) => void
  onPrinterOverride: (value: PrinterStatus | null) => void
}

export function DevPanel({ network, printerOverride, onNetwork, onPrinterOverride }: Props) {
  const clear = useCartStore((state) => state.clearCart)
  const add = useCartStore((state) => state.addItem)
  const loadBusyCart = () => {
    clear()
    products.slice(0, 8).forEach((product) => {
      add(createCartItemDraft(product, getDefaultProductSelection(product)))
    })
  }

  return (
    <details className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-sm">
      <summary className="cursor-pointer font-black">Outils de démonstration</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Button className="min-h-10 py-2" onClick={clear}>
          Panier vide
        </Button>
        <Button className="min-h-10 py-2" onClick={loadBusyCart}>
          Panier chargé
        </Button>
        <label className="font-bold">
          Réseau
          <select
            className="ml-2 min-h-10 rounded-[8px] border bg-white px-2"
            value={network}
            onChange={(event) => onNetwork(event.target.value as NetworkStatus)}
          >
            <option value="online">En ligne</option>
            <option value="offline">Hors ligne</option>
            <option value="syncing">Synchronisation</option>
            <option value="sync-error">Erreur de sync</option>
          </select>
        </label>
        <label className="font-bold">
          Imprimante
          <select
            className="ml-2 min-h-10 rounded-[8px] border bg-white px-2"
            value={printerOverride ?? 'real'}
            onChange={(event) =>
              onPrinterOverride(
                event.target.value === 'real' ? null : (event.target.value as PrinterStatus),
              )
            }
          >
            <option value="real">Statut réel</option>
            <option value="unknown">Vérification</option>
            <option value="unavailable">Indisponible</option>
            <option value="permission-required">Autorisation requise</option>
            <option value="ready">Prête</option>
            <option value="printing">Impression</option>
            <option value="disconnected">Déconnectée</option>
            <option value="paper-out">Plus de papier</option>
            <option value="error">Erreur</option>
          </select>
        </label>
      </div>
      <UsbPrinterPanel />
    </details>
  )
}
