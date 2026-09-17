import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  getSalesBackupService,
  type SalesBackupService,
  type VerifiedBackupResult,
} from '../../services/salesBackupService'
import { getSalesLedgerService, type SalesLedgerService } from '../../services/salesLedgerService'
import type {
  ClosureLedgerEntry,
  ClosurePreview,
  ClosureTotals,
  IntegrityVerification,
} from '../../types/salesLedger'
import { formatMoney } from '../../utils/money'

export type LedgerManagementProps = {
  onClose: () => void
  ledgerService?: Pick<
    SalesLedgerService,
    'verifyIntegrity' | 'previewClosure' | 'closePeriod' | 'getLastClosureEnd'
  >
  backupService?: Pick<SalesBackupService, 'saveVerifiedBackup'>
  now?: () => Date
}

type BusyAction = 'integrity' | 'backup' | 'preview' | 'closure' | null

export function LedgerManagement({
  onClose,
  ledgerService = getSalesLedgerService(),
  backupService = getSalesBackupService(),
  now = () => new Date(),
}: LedgerManagementProps) {
  const [initialNow] = useState(now)
  const [section, setSection] = useState<'backup' | 'closure'>('backup')
  const [integrity, setIntegrity] = useState<IntegrityVerification | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backupResult, setBackupResult] = useState<VerifiedBackupResult | null>(null)
  const [periodStart, setPeriodStart] = useState(() => toDateTimeLocal(startOfLocalDay(initialNow)))
  const [periodEnd, setPeriodEnd] = useState(() => toDateTimeLocal(initialNow))
  const [preview, setPreview] = useState<ClosurePreview | null>(null)
  const [closure, setClosure] = useState<ClosureLedgerEntry | null>(null)
  const [confirmClosure, setConfirmClosure] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    void ledgerService
      .getLastClosureEnd()
      .then((lastClosureEnd) => {
        if (mountedRef.current && lastClosureEnd) {
          setPeriodStart(toDateTimeLocal(new Date(lastClosureEnd)))
        }
      })
      .catch(() => {
        // La vérification ou la prévisualisation affichera une erreur exploitable.
      })
    return () => {
      mountedRef.current = false
    }
  }, [ledgerService])

  const runExclusive = async (
    action: Exclude<BusyAction, null>,
    operation: () => Promise<void>,
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(action)
    setError(null)
    setMessage(null)
    try {
      await operation()
    } catch {
      if (mountedRef.current) {
        if (action === 'closure') setConfirmClosure(false)
        setError(ledgerActionError(action))
      }
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(null)
    }
  }

  const verify = () =>
    runExclusive('integrity', async () => {
      const result = await ledgerService.verifyIntegrity()
      if (!mountedRef.current) return
      setIntegrity(result)
      if (!result.valid) {
        setError(
          'Certaines ventes enregistrées ne peuvent pas être vérifiées. La sauvegarde et la clôture sont bloquées.',
        )
      }
    })

  const saveBackup = () =>
    runExclusive('backup', async () => {
      setBackupResult(null)
      const result = await backupService.saveVerifiedBackup(now())
      if (!mountedRef.current) return
      setBackupResult(result)
      if (result.status === 'cancelled') {
        setMessage('Enregistrement annulé. Aucune sauvegarde n’a été créée.')
      }
    })

  const loadPreview = () =>
    runExclusive('preview', async () => {
      setClosure(null)
      const result = await ledgerService.previewClosure(
        parseDateTimeLocal(periodStart),
        parseDateTimeLocal(periodEnd),
        now(),
      )
      if (!mountedRef.current) return
      setPreview(result)
      setIntegrity(result.integrity)
    })

  const closePeriod = () =>
    runExclusive('closure', async () => {
      const latestIntegrity = await ledgerService.verifyIntegrity()
      if (!latestIntegrity.valid) {
        setIntegrity(latestIntegrity)
        throw new Error('Les ventes enregistrées ne peuvent pas être vérifiées.')
      }
      const result = await ledgerService.closePeriod(
        parseDateTimeLocal(periodStart),
        parseDateTimeLocal(periodEnd),
      )
      if (!mountedRef.current) return
      setClosure(result)
      setPreview(null)
      setConfirmClosure(false)
      setIntegrity(await ledgerService.verifyIntegrity())
      setMessage('Clôture enregistrée. Les ventes restent disponibles dans l’historique.')
    })

  const actionsAllowed = integrity?.valid === true && busy === null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#f2eee5] text-stone-950"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ledger-management-title"
    >
      <header className="flex min-h-16 items-center justify-between gap-4 bg-[#18231e] px-5 py-3 text-white">
        <div>
          <h2 id="ledger-management-title" className="text-xl font-black">
            Clôture et sauvegarde
          </h2>
          <p className="text-sm font-bold text-stone-300">Mode responsable</p>
        </div>
        <Button
          variant="headerSecondary"
          disabled={busy !== null}
          onClick={onClose}
        >
          Fermer
        </Button>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-y-auto p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3" role="tablist" aria-label="Clôture et sauvegarde">
          <Button
            role="tab"
            aria-selected={section === 'backup'}
            variant={section === 'backup' ? 'primary' : 'secondary'}
            className="min-h-14 text-lg"
            disabled={busy !== null}
            onClick={() => setSection('backup')}
          >
            Sauvegarde
          </Button>
          <Button
            role="tab"
            aria-selected={section === 'closure'}
            variant={section === 'closure' ? 'primary' : 'secondary'}
            className="min-h-14 text-lg"
            disabled={busy !== null}
            onClick={() => setSection('closure')}
          >
            Clôture de caisse
          </Button>
        </div>

        <section className="mt-5 border-b border-stone-300 pb-5" aria-labelledby="integrity-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 id="integrity-title" className="text-xl font-black">
                Vérification des ventes
              </h3>
              <p className="mt-1 font-semibold text-stone-700">
                Contrôle que les ventes enregistrées sont complètes et n’ont pas été modifiées.
              </p>
            </div>
            <Button
              variant="secondary"
              className="min-h-14"
              disabled={busy !== null}
              onClick={() => void verify()}
            >
              {busy === 'integrity' ? 'Vérification…' : 'Vérifier les ventes'}
            </Button>
          </div>
          {integrity ? <IntegrityDetails verification={integrity} /> : null}
        </section>

        {error ? (
          <p
            className="mt-4 border border-rose-300 bg-rose-50 p-4 font-bold text-rose-950"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {message ? (
          <p
            className="mt-4 border border-amber-300 bg-amber-50 p-4 font-bold text-amber-950"
            role="status"
          >
            {message}
          </p>
        ) : null}

        {section === 'backup' ? (
          <section className="py-5" aria-labelledby="backup-title">
            <h3 id="backup-title" className="text-2xl font-black">
              Enregistrer une sauvegarde
            </h3>
            <p className="mt-2 max-w-3xl font-semibold text-stone-700">
              Crée une copie de sécurité des ventes et vous permet de choisir où l’enregistrer. Vous
              pouvez sauvegarder sans clôturer la caisse.
            </p>
            <Button
              variant="primary"
              className="mt-5 min-h-16 text-lg"
              disabled={!actionsAllowed}
              onClick={() => void saveBackup()}
            >
              {busy === 'backup' ? 'Enregistrement…' : 'Enregistrer une sauvegarde'}
            </Button>
            {!integrity ? (
              <p className="mt-3 font-bold text-stone-700">
                Vérifiez d’abord les ventes enregistrées.
              </p>
            ) : null}
            {backupResult?.status === 'verified' ? <BackupSuccess result={backupResult} /> : null}
          </section>
        ) : (
          <section className="py-5" aria-labelledby="closure-title">
            <h3 id="closure-title" className="text-2xl font-black">
              Clôturer la caisse
            </h3>
            <p className="mt-2 font-semibold text-stone-700">
              Enregistre les totaux de la période. Les ventes et corrections restent disponibles.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="font-black">
                Début de période
                <input
                  className="mt-2 min-h-14 w-full rounded-[8px] border border-stone-400 bg-white px-3 font-bold"
                  type="datetime-local"
                  value={periodStart}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setPeriodStart(event.target.value)
                    setPreview(null)
                  }}
                />
              </label>
              <label className="font-black">
                Fin de période
                <input
                  className="mt-2 min-h-14 w-full rounded-[8px] border border-stone-400 bg-white px-3 font-bold"
                  type="datetime-local"
                  value={periodEnd}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setPeriodEnd(event.target.value)
                    setPreview(null)
                  }}
                />
              </label>
            </div>
            <Button
              className="mt-5 min-h-14"
              disabled={!actionsAllowed || !periodStart || !periodEnd}
              onClick={() => void loadPreview()}
            >
              {busy === 'preview' ? 'Calcul des totaux…' : 'Afficher les totaux'}
            </Button>

            {preview ? (
              <div className="mt-5 border-t border-stone-300 pt-5">
                <h4 className="text-xl font-black">Totaux de la période</h4>
                <p className="mt-1 font-bold text-stone-700">
                  {preview.terminal.displayName} ·{' '}
                  {formatPeriod(preview.periodStart, preview.periodEnd)}
                </p>
                <TotalsDetails totals={preview.totals} />
                <VatDetails preview={preview} />
                <Button
                  variant="danger"
                  className="mt-5 min-h-14 text-lg"
                  disabled={busy !== null}
                  onClick={() => setConfirmClosure(true)}
                >
                  Continuer
                </Button>
              </div>
            ) : null}

            {closure ? (
              <div className="mt-5 border border-emerald-400 bg-emerald-50 p-5" role="status">
                <h4 className="text-xl font-black text-emerald-950">Clôture enregistrée</h4>
                <p className="mt-1 font-bold text-emerald-950">
                  {closure.source.terminal.displayName} ·{' '}
                  {formatPeriod(closure.closure.periodStart, closure.closure.periodEnd)}
                </p>
                <p className="mt-1 font-bold text-emerald-950">Totaux enregistrés</p>
                <TotalsDetails totals={closure.closure.totals} />
                <Button
                  variant="primary"
                  className="mt-5 min-h-14 text-lg"
                  disabled={busy !== null}
                  onClick={() => void saveBackup()}
                >
                  {busy === 'backup' ? 'Enregistrement…' : 'Sauvegarder maintenant'}
                </Button>
                {backupResult?.status === 'verified' ? (
                  <BackupSuccess result={backupResult} />
                ) : null}
              </div>
            ) : null}
          </section>
        )}
      </main>

      {confirmClosure && preview ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-stone-950/70 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-closure-title"
          onClick={() => setConfirmClosure(false)}
        >
          <section
            className="w-full max-w-lg border border-stone-300 bg-[#fffdf8] p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-closure-title" className="text-2xl font-black">
              Confirmer cette clôture ?
            </h3>
            <p className="mt-3 font-bold text-stone-800">
              {formatPeriod(preview.periodStart, preview.periodEnd)}
            </p>
            <p className="mt-2 text-lg font-black">
              Total net : {formatMoney(preview.totals.netTotalCents)}
            </p>
            <p className="mt-2 font-semibold text-stone-700">
              Les totaux seront enregistrés définitivement. Les ventes resteront disponibles.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button disabled={busy !== null} onClick={() => setConfirmClosure(false)}>
                Retour
              </Button>
              <Button variant="danger" disabled={busy !== null} onClick={() => void closePeriod()}>
                {busy === 'closure' ? 'Clôture…' : 'Clôturer la caisse'}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function IntegrityDetails({ verification }: { verification: IntegrityVerification }) {
  const status = verification.valid
    ? verification.complete
      ? 'Ventes vérifiées'
      : 'Ventes vérifiées, historique incomplet'
    : 'Vérification impossible'
  return (
    <div
      className={`mt-4 border p-4 ${
        verification.valid
          ? verification.complete
            ? 'border-emerald-400 bg-emerald-50'
            : 'border-amber-400 bg-amber-50'
          : 'border-rose-400 bg-rose-50'
      }`}
      role="status"
    >
      <p className="text-lg font-black">{status}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-bold text-stone-600">Nombre de ventes</dt>
          <dd className="font-black">{verification.sealedOrderCount}</dd>
        </div>
        <div>
          <dt className="font-bold text-stone-600">État</dt>
          <dd className="font-black">{verification.complete ? 'Complet' : 'À vérifier'}</dd>
        </div>
      </dl>
      {verification.warnings.length ? (
        <p className="mt-3 font-bold text-amber-950">
          Certaines anciennes ventes ne peuvent pas être vérifiées automatiquement.
        </p>
      ) : null}
      {verification.errors.length ? (
        <p className="mt-3 font-bold text-rose-950">
          Certaines données sont incomplètes ou ont été modifiées. La sauvegarde et la clôture sont
          bloquées.
        </p>
      ) : null}
    </div>
  )
}

function TotalsDetails({ totals }: { totals: ClosureTotals }) {
  const values = [
    ['Ventes', String(totals.saleCount)],
    ['Ventes avant corrections', formatMoney(totals.grossSalesCents)],
    ['Corrections', String(totals.correctionCount)],
    ['Montant des corrections', formatMoney(totals.correctionTotalCents)],
    ['Montant attendu', formatMoney(totals.netTotalCents)],
    ['Carte bancaire', formatMoney(totals.paymentTotalsCents.card)],
    ['Espèces', formatMoney(totals.paymentTotalsCents.cash)],
  ]
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-stone-300 py-4 sm:grid-cols-4">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt className="text-sm font-bold text-stone-600">{label}</dt>
          <dd className="text-lg font-black">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function VatDetails({ preview }: { preview: ClosurePreview }) {
  if (!preview.vatBreakdown) {
    return <p className="mt-4 font-bold text-amber-900">{preview.vatUnavailableReason}</p>
  }
  if (preview.vatBreakdown.length === 0) {
    return <p className="mt-4 font-bold text-stone-700">Aucune vente sur cette période.</p>
  }
  return (
    <div className="mt-4">
      <h5 className="font-black">Ventilation TVA</h5>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {preview.vatBreakdown.map((entry) => (
          <div key={entry.rate} className="border-l-4 border-stone-400 pl-3">
            <dt className="font-black">TVA {entry.rate} %</dt>
            <dd className="font-semibold">
              TTC {formatMoney(entry.grossCents)} · TVA {formatMoney(entry.vatCents)} · HT{' '}
              {formatMoney(entry.netCents)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function BackupSuccess({
  result,
}: {
  result: Extract<VerifiedBackupResult, { status: 'verified' }>
}) {
  const saleCount = result.archive.entries.filter((entry) => entry.kind === 'sale').length
  return (
    <div className="mt-5 border border-emerald-400 bg-emerald-50 p-5" role="status">
      <h4 className="text-xl font-black text-emerald-950">Sauvegarde enregistrée</h4>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-bold text-stone-600">Caisse</dt>
          <dd className="font-black">{result.archive.source.terminal.displayName}</dd>
        </div>
        <div>
          <dt className="font-bold text-stone-600">Dernière sauvegarde</dt>
          <dd className="font-black">{formatFriendlyDateTime(result.archive.exportedAt)}</dd>
        </div>
        <div>
          <dt className="font-bold text-stone-600">Ventes sauvegardées</dt>
          <dd className="font-black">{saleCount}</dd>
        </div>
      </dl>
    </div>
  )
}

function parseDateTimeLocal(value: string): Date {
  if (!value) return new Date(Number.NaN)
  return new Date(value)
}

function toDateTimeLocal(date: Date): string {
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

function formatPeriod(start: string, end: string): string {
  return `${formatDateTime(start)} → ${formatDateTime(end)}`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatFriendlyDateTime(value: string, reference = new Date()): string {
  const date = new Date(value)
  const time = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' }).format(date)
  const startOfReference = startOfLocalDay(reference).getTime()
  const startOfDate = startOfLocalDay(date).getTime()
  if (startOfDate === startOfReference) return `Aujourd’hui à ${time}`
  if (startOfDate === startOfReference - 86_400_000) return `Hier à ${time}`
  return formatDateTime(value)
}

function ledgerActionError(action: Exclude<BusyAction, null>): string {
  if (action === 'integrity') {
    return 'Impossible de vérifier les ventes enregistrées. Réessayez.'
  }
  if (action === 'backup') {
    return 'La sauvegarde n’a pas pu être enregistrée. Vérifiez l’espace disponible, puis réessayez.'
  }
  if (action === 'preview') {
    return 'Les totaux n’ont pas pu être calculés. Vérifiez les dates, puis réessayez.'
  }
  return 'La caisse n’a pas pu être clôturée. Vérifiez les dates et les ventes enregistrées, puis réessayez.'
}
