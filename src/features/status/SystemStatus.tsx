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
}: {
  network: NetworkStatus
  printer: PrinterStatus
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm font-bold">
      <span>Réseau : {networkLabels[network]}</span>
      <span className="text-stone-300" aria-live="polite">
        Imprimante : {printerLabels[printer]}
      </span>
    </div>
  )
}
