import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  getResponsibleModeService,
  type ResponsibleMode,
} from '../../services/responsibleModeService'
import { synchronizationService, type SyncDiagnostics } from '../../services/synchronizationService'
import { synchronizationStatus } from '../../services/synchronizationStatus'
import { tabletAuthorizationMessages } from '../../services/tabletEnrollmentService'

type Props = {
  responsibleMode?: ResponsibleMode
  service?: Pick<typeof synchronizationService, 'diagnostics' | 'retry' | 'setEnabled'>
  onConfigure: () => void
  onLocked: () => void
}

function dateLabel(value: string | number | null | undefined, empty = 'Non disponible') {
  if (value === null || value === undefined) return empty
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Non disponible'
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function SynchronizationStatus({
  responsibleMode = getResponsibleModeService(),
  service = synchronizationService,
  onConfigure,
  onLocked,
}: Props) {
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const readVersion = useRef(0)
  const lockScreen = useEffectEvent(onLocked)

  useEffect(() => {
    mounted.current = true
    let reading = false
    const refresh = async () => {
      if (!responsibleMode.isUnlocked()) {
        lockScreen()
        return
      }
      if (reading || pending.current) return
      reading = true
      const version = ++readVersion.current
      try {
        const state = await service.diagnostics()
        if (mounted.current && version === readVersion.current && responsibleMode.isUnlocked())
          setDiagnostics(state)
      } catch {
        if (mounted.current && version === readVersion.current) setDiagnostics(null)
      } finally {
        reading = false
        if (mounted.current && version === readVersion.current) setLoading(false)
      }
    }
    const lockHidden = () => {
      if (document.visibilityState === 'hidden') {
        responsibleMode.lock()
        lockScreen()
      }
    }
    void refresh()
    const poll = window.setInterval(() => void refresh(), 5000)
    const checkLock = window.setInterval(() => {
      if (!responsibleMode.isUnlocked()) lockScreen()
    }, 500)
    document.addEventListener('visibilitychange', lockHidden)
    return () => {
      mounted.current = false
      readVersion.current += 1
      window.clearInterval(poll)
      window.clearInterval(checkLock)
      document.removeEventListener('visibilitychange', lockHidden)
    }
  }, [responsibleMode, service])

  const run = async (operation?: () => Promise<void>) => {
    if (pending.current) return
    try {
      responsibleMode.requireUnlocked()
    } catch {
      onLocked()
      return
    }
    pending.current = true
    const version = ++readVersion.current
    setBusy(true)
    setMessage(null)
    let feedback: string | null = null
    try {
      if (operation) {
        await operation()
        feedback = 'Demande de reprise transmise. La réception des opérations reste à confirmer.'
      }
    } catch {
      feedback =
        'La reprise n’a pas pu être demandée. Vérifiez l’état affiché. Les opérations restent conservées.'
    }
    try {
      if (!mounted.current || version !== readVersion.current) return
      if (!responsibleMode.isUnlocked()) {
        onLocked()
        return
      }
      const state = await service.diagnostics()
      if (mounted.current && version === readVersion.current && responsibleMode.isUnlocked()) {
        setDiagnostics(state)
        setMessage(feedback)
      }
    } catch {
      if (mounted.current && version === readVersion.current) {
        setDiagnostics(null)
        setMessage('Suivi non disponible. Les opérations restent conservées sur cette tablette.')
      }
    } finally {
      pending.current = false
      if (mounted.current && version === readVersion.current) {
        setBusy(false)
        setLoading(false)
      }
    }
  }

  if (!responsibleMode.isUnlocked()) return <p role="alert">Mode responsable verrouillé.</p>
  const state = synchronizationStatus(diagnostics)
  const countersValid =
    diagnostics &&
    [diagnostics.pendingEvents, diagnostics.sending, diagnostics.errors].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  return (
    <section aria-label="Synchronisation des données" className="max-w-3xl text-stone-950">
      <div role="status" aria-live="polite">
        <h3 className="text-xl font-black">{loading ? 'Lecture du suivi…' : state.title}</h3>
        {!loading && <p className="mt-2">{state.message}</p>}
      </div>
      <dl className="my-5 grid gap-4 border-y border-stone-300 py-4 sm:grid-cols-3">
        {(
          [
            ['Opérations non confirmées', diagnostics?.pendingEvents],
            ['En cours d’envoi', diagnostics?.sending],
            ['En erreur', diagnostics?.errors],
          ] as const
        ).map(([label, count]) => (
          <div key={label}>
            <dt className="font-bold">{label}</dt>
            <dd className="text-xl font-black tabular-nums">
              {!loading && countersValid ? count : 'Non disponible'}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="space-y-3">
        <div>
          <dt className="font-bold">Autorisation de la tablette</dt>
          <dd>
            {Object.entries(tabletAuthorizationMessages).find(
              ([status]) => status === diagnostics?.authentication,
            )?.[1] ?? 'Non disponible'}
          </dd>
        </div>
        <div>
          <dt className="font-bold">Dernière synchronisation confirmée (réception serveur)</dt>
          <dd>
            {dateLabel(
              diagnostics?.lastServerReceivedAt,
              diagnostics?.lastServerReceivedAt === null && diagnostics?.lastSuccessAt === null
                ? 'Aucune'
                : 'Non disponible',
            )}
          </dd>
        </div>
        <div>
          <dt className="font-bold">Confirmation enregistrée sur la tablette</dt>
          <dd>{dateLabel(diagnostics?.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt className="font-bold">Dernier échange réel avec le service</dt>
          <dd>{dateLabel(diagnostics?.lastExchangeAt)}</dd>
        </div>
        {diagnostics && (
          <div>
            <dt className="font-bold">Envoi automatique</dt>
            <dd>
              {typeof diagnostics.enabled === 'boolean'
                ? diagnostics.enabled
                  ? 'Activé'
                  : 'Désactivé'
                : 'Non disponible'}
            </dd>
          </div>
        )}
        {diagnostics?.errorCategory && diagnostics.errorCategory !== 'none' && (
          <div>
            <dt className="font-bold">Dernier problème à traiter</dt>
            <dd>{state.title}</dd>
          </div>
        )}
      </dl>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button autoFocus disabled={busy} onClick={() => void run()}>
          Actualiser le suivi
        </Button>
        <Button
          variant="primary"
          disabled={loading || busy || !state.retry}
          onClick={() => void run(() => service.retry())}
        >
          Relancer la synchronisation
        </Button>
        {diagnostics?.authentication === 'authorized' && diagnostics.enabled === false && (
          <Button disabled={busy} onClick={() => void run(() => service.setEnabled(true))}>
            Réactiver la synchronisation
          </Button>
        )}
        {state.settings && (
          <Button
            disabled={busy}
            onClick={() => {
              try {
                responsibleMode.requireUnlocked()
                onConfigure()
              } catch {
                onLocked()
              }
            }}
          >
            Paramètres de synchronisation
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="mt-4 font-bold">
          {message}
        </p>
      )}
    </section>
  )
}
