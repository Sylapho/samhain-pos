import type { NetworkStatus, PrinterStatus } from '../../types/system'

const networkLabels: Record<NetworkStatus, string> = { online: 'En ligne', offline: 'Hors ligne', syncing: 'Synchronisation', 'sync-error': 'Sync en attente' }
const printerLabels: Record<PrinterStatus, string> = { ready: 'Imprimante prête', printing: 'Impression', disconnected: 'Imprimante déconnectée', 'paper-out': 'Plus de papier', error: 'Erreur imprimante' }

export function SystemStatus({ network, printer }: { network: NetworkStatus; printer: PrinterStatus }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 text-sm font-bold"><span className="rounded-full bg-slate-800 px-3 py-1.5 text-white">● {networkLabels[network]}</span><span className="rounded-full border border-slate-600 px-3 py-1.5 text-slate-100">{printerLabels[printer]}</span></div>
}
