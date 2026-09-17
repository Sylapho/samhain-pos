import type { PrinterStatus } from '../../types/system'
const printerLabels: Record<PrinterStatus, string> = {
  unknown: 'Vérification…',
  unavailable: 'Non disponible sur cet appareil',
  'permission-required': 'Connexion à autoriser',
  ready: 'Connectée',
  printing: 'Impression en cours',
  disconnected: 'Non détectée',
  'paper-out': 'Plus de papier',
  'cover-open': 'Capot ouvert',
  'status-unavailable': 'État non vérifié',
  error: 'À vérifier',
}

export function SystemStatus({
  printer,
  onPrinterClick,
}: {
  printer: PrinterStatus
  onPrinterClick: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm font-bold">
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
