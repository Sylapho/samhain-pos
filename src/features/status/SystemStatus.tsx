import type { NetworkStatus, PrinterStatus } from '../../types/system'

const networkLabels: Record<NetworkStatus, string> = {
  online: 'En ligne',
  offline: 'Hors ligne',
  syncing: 'Synchronisation',
  'sync-error': 'Sync en attente',
}
const printerLabels: Record<PrinterStatus, string> = {
  unknown: 'Vérification…',
  unavailable: 'Indisponible sur cet appareil',
  'permission-required': 'Autorisation requise',
  ready: 'Prête',
  printing: 'Impression en cours',
  disconnected: 'Déconnectée',
  'paper-out': 'Papier épuisé',
  'cover-open': 'Capot ouvert',
  'status-unavailable': 'Statut illisible',
  error: 'Erreur imprimante',
}

export function SystemStatus({
  network,
  printer,
  onPrinterClick,
}: {
  network: NetworkStatus
  printer: PrinterStatus
  onPrinterClick: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm font-bold">
      <span>Réseau : {networkLabels[network]}</span>
      <button
        type="button"
        className="min-h-11 rounded-[8px] border border-stone-600 px-3 text-stone-200 underline decoration-stone-500 underline-offset-4 active:bg-white/10 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white"
        aria-label={`Configurer l’imprimante. Statut : ${printerLabels[printer]}`}
        aria-live="polite"
        onClick={onPrinterClick}
      >
        Imprimante : {printerLabels[printer]}
      </button>
    </div>
  )
}
