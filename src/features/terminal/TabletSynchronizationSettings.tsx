import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { enrollmentScope } from '../../config/enrollmentScope'
import type { TabletAuthorization } from '../../native/tabletAuth'
import {
  tabletAuthorizationMessages,
  isEnrollmentUuid,
  tabletEnrollmentService,
  type TabletEnrollmentService,
} from '../../services/tabletEnrollmentService'

type Scope = { organizationId: string; festivalId: string }
const reviewKey = (
  authorization: TabletAuthorization,
  scope: Scope,
  chainId: string,
  replacement: string,
) =>
  JSON.stringify([
    authorization.status,
    authorization.requestId,
    authorization.installationId,
    scope.organizationId,
    scope.festivalId,
    chainId,
    replacement,
  ])

export function TabletSynchronizationSettings({
  terminalId,
  service = tabletEnrollmentService,
}: {
  terminalId: string
  service?: TabletEnrollmentService
}) {
  const [authorization, setAuthorization] = useState<TabletAuthorization>(() =>
    service.initialStatus(),
  )
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [managerConnected, setManagerConnected] = useState(false)
  const [managerAction, setManagerAction] = useState<'approve' | 'reject' | 'revoke'>('approve')
  const [organizationId, setOrganizationId] = useState<string>(enrollmentScope.organizationId)
  const [festivalId, setFestivalId] = useState<string>(enrollmentScope.festivalId)
  const [chainId, setChainId] = useState('')
  const [replacesInstallationId, setReplacesInstallationId] = useState('')
  const [code, setCode] = useState('')
  const [review, setReview] = useState<Awaited<
    ReturnType<TabletEnrollmentService['inspect']>
  > | null>(null)
  const [reviewedScope, setReviewedScope] = useState('')
  const newRequest = [
    'rejected',
    'revoked',
    'session_expired',
    'attempts_exceeded',
    'invitation_expired',
    'authorization_denied',
  ].includes(authorization.status)
  const scopeLocked = !!authorization.requestedScope && !newRequest
  const scope: Scope =
    !newRequest && authorization.requestedScope
      ? authorization.requestedScope
      : {
          organizationId: organizationId.trim().toLowerCase(),
          festivalId: festivalId.trim().toLowerCase(),
        }
  const validScope = isEnrollmentUuid(scope.organizationId) && isEnrollmentUuid(scope.festivalId)
  const currentReview = reviewKey(authorization, scope, chainId, replacesInstallationId)
  const reviewed = !!review && reviewedScope === currentReview

  useEffect(() => {
    if (service.initialStatus().status === 'not_configured') return
    let active = true
    void service.status().then(
      (value) => {
        if (!active) return
        setAuthorization(value)
        setOrganizationId(
          value.requestedScope?.organizationId ??
            value.organizationId ??
            enrollmentScope.organizationId,
        )
        setFestivalId(
          value.requestedScope?.festivalId ?? value.festivalId ?? enrollmentScope.festivalId,
        )
        setChainId(value.chainId ?? '')
        setLoaded(true)
      },
      () => {
        if (active) setError('Impossible de lire l’autorisation. Les ventes restent locales.')
      },
    )
    void service.managerStatus().then(
      (connected) => {
        if (active) setManagerConnected(connected)
      },
      () => {
        if (active) setManagerConnected(false)
      },
    )
    return () => {
      active = false
    }
  }, [service])

  const run = async (operation: () => Promise<TabletAuthorization>) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      setAuthorization(await operation())
      setLoaded(true)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Vérification impossible. Les ventes locales sont conservées.',
      )
    } finally {
      busy.current = false
      setPending(false)
      setCode('')
    }
  }

  const examine = () =>
    run(async () => {
      setReview(null)
      setReviewedScope('')
      let current = authorization
      if (!current.requestId || newRequest) {
        current = await service.request({ terminalId, ...scope, reconnect: newRequest })
        // Keep the durable native request visible even if the subsequent inspection fails.
        setAuthorization(current)
      }
      if (!current.requestId || !current.installationId)
        throw new Error(tabletAuthorizationMessages[current.status])
      const requested = current.requestedScope ?? scope
      const dossier = await service.inspect({ requestId: current.requestId, ...requested })
      if (
        dossier.requestId !== current.requestId ||
        dossier.installationId !== current.installationId ||
        (current.chainId && dossier.chainId !== current.chainId)
      )
        throw new Error(
          'Le dossier ne correspond pas à cette tablette. Les données locales sont conservées.',
        )
      setChainId(dossier.chainId)
      setReview(dossier)
      setReviewedScope(reviewKey(current, requested, dossier.chainId, replacesInstallationId))
      return current
    })
  const inputStyle = 'mt-1 min-h-12 w-full border border-stone-400 bg-white px-3 text-stone-950'

  return (
    <div className="mt-4 border-b border-stone-300 pb-3">
      <p className="font-bold" aria-live="polite">
        {tabletAuthorizationMessages[authorization.status]}
      </p>
      <p className="mt-1 text-sm text-stone-700">
        Les ventes et impressions fonctionnent sans connexion. Le compte responsable permet
        d’autoriser les échanges avec le serveur.
      </p>
      {authorization.status === 'authorized' ? (
        <p className="mt-1 text-sm text-stone-700">
          Dernier état enregistré. Vérifiez la session pour connaître l’état serveur actuel.
        </p>
      ) : null}
      {authorization.status !== 'not_configured' ? (
        <>
          {authorization.status !== 'authorized' || managerAction === 'revoke' ? (
            <form
              className="mt-3 border-t border-stone-300 pt-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (busy.current || !managerConnected || (managerAction !== 'revoke' && !reviewed))
                  return
                void run(() =>
                  service.manager({
                    action: managerAction,
                    body: {
                      organizationId: scope.organizationId,
                      festivalId: scope.festivalId,
                      chainId,
                      ...(managerAction === 'revoke'
                        ? { installationId: authorization.installationId }
                        : {
                            requestId: authorization.requestId,
                            replacesInstallationId: replacesInstallationId.trim() || undefined,
                          }),
                    },
                  }),
                )
              }}
            >
              <p className="font-bold">
                {managerAction === 'approve'
                  ? 'Autoriser cette tablette'
                  : managerAction === 'reject'
                    ? 'Refuser cette demande'
                    : 'Confirmer la révocation serveur'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!managerConnected ? (
                  <Button
                    disabled={pending || !loaded}
                    onClick={() =>
                      void run(async () => {
                        setReview(null)
                        setReviewedScope('')
                        await service.managerLogin()
                        setManagerConnected(true)
                        return authorization
                      })
                    }
                  >
                    Se connecter au compte responsable
                  </Button>
                ) : (
                  <p className="self-center font-bold">Compte responsable connecté</p>
                )}
                {managerAction !== 'revoke' ? (
                  <Button
                    disabled={pending || !loaded || !managerConnected || !validScope}
                    onClick={() => void examine()}
                  >
                    Examiner le dossier serveur
                  </Button>
                ) : null}
              </div>
              {newRequest && managerAction === 'approve' ? (
                <p className="mt-2 text-sm">
                  L’examen préparera une nouvelle demande. L’identité et les ventes locales sont
                  conservées.
                </p>
              ) : null}
              {reviewed ? (
                <p className="mt-2 text-sm" aria-live="polite">
                  Caisse déclarée : {review.terminalId}. {review.prefixCount} événements et{' '}
                  {review.legacyCount} commandes historiques.{' '}
                  {review.restored
                    ? 'Archive restaurée : vérifiez le remplacement dans les options avancées.'
                    : 'Installation sans restauration déclarée.'}
                </p>
              ) : null}
              {managerAction === 'revoke' ? (
                <p className="mt-2 font-bold text-amber-950">
                  Les échanges de cette installation seront refusés. Les ventes et données locales
                  restent conservées.
                </p>
              ) : null}
              <Button
                className="mt-3"
                variant={managerAction === 'approve' ? 'primary' : 'danger'}
                type="submit"
                disabled={pending || !managerConnected || (managerAction !== 'revoke' && !reviewed)}
              >
                {managerAction === 'approve'
                  ? 'Autoriser côté serveur'
                  : managerAction === 'reject'
                    ? 'Confirmer le refus'
                    : 'Confirmer la révocation'}
              </Button>
              {managerAction !== 'approve' ? (
                <Button
                  className="ml-2 mt-3"
                  disabled={pending}
                  onClick={() => setManagerAction('approve')}
                >
                  Annuler
                </Button>
              ) : null}
            </form>
          ) : null}

          <details className="mt-3 border-t border-stone-300 pt-2">
            <summary className="min-h-12 cursor-pointer py-3 font-bold">
              Options avancées d’enrôlement
            </summary>
            <p className="text-sm">
              Les identifiants fournis sont déjà renseignés. Une demande existante conserve son
              périmètre ; les droits sont toujours vérifiés côté serveur.
            </p>
            <label className="mt-3 block font-bold">
              Organisation — Identifiant UUID
              <input
                className={inputStyle}
                required
                autoComplete="off"
                spellCheck={false}
                readOnly={scopeLocked}
                disabled={pending || !loaded}
                value={scopeLocked ? scope.organizationId : organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
                aria-invalid={!isEnrollmentUuid(scope.organizationId)}
              />
            </label>
            {!isEnrollmentUuid(scope.organizationId) ? (
              <p role="alert">L’identifiant de l’organisation doit être un UUID valide.</p>
            ) : null}
            <label className="mt-3 block font-bold">
              Festival — Identifiant UUID
              <input
                className={inputStyle}
                required
                autoComplete="off"
                spellCheck={false}
                readOnly={scopeLocked}
                disabled={pending || !loaded}
                value={scopeLocked ? scope.festivalId : festivalId}
                onChange={(event) => setFestivalId(event.target.value)}
                aria-invalid={!isEnrollmentUuid(scope.festivalId)}
              />
            </label>
            {!isEnrollmentUuid(scope.festivalId) ? (
              <p role="alert">L’identifiant du festival doit être un UUID valide.</p>
            ) : null}
            {authorization.requestId ? (
              <p className="mt-2 break-all text-sm">
                Demande à faire approuver : {authorization.requestId}
              </p>
            ) : null}
            {chainId ? (
              <p className="mt-2 break-all text-sm">Chaîne de cette tablette : {chainId}</p>
            ) : null}
            <label className="mt-3 block">
              Installation remplacée (si applicable)
              <input
                className={inputStyle}
                disabled={pending}
                value={replacesInstallationId}
                onChange={(event) => setReplacesInstallationId(event.target.value)}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={pending} onClick={() => void run(() => service.status(true))}>
                Vérifier / rafraîchir la session
              </Button>
              <Button
                disabled={
                  pending || !loaded || !validScope || authorization.status === 'authorized'
                }
                onClick={() =>
                  void run(() => service.request({ terminalId, ...scope, reconnect: newRequest }))
                }
              >
                {newRequest
                  ? 'Créer une nouvelle demande / reconnecter'
                  : 'Demander l’enrôlement / reconnecter'}
              </Button>
              {authorization.requestId && authorization.status !== 'authorized' ? (
                <Button disabled={pending} onClick={() => setManagerAction('reject')}>
                  Refuser cette demande
                </Button>
              ) : null}
              {authorization.installationId && authorization.chainId ? (
                <Button
                  disabled={pending}
                  onClick={() => {
                    setChainId(authorization.chainId ?? '')
                    setManagerAction('revoke')
                  }}
                >
                  Révoquer cette installation
                </Button>
              ) : null}
              {managerConnected ? (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await service.managerLogout()
                      setManagerConnected(false)
                      setReview(null)
                      setReviewedScope('')
                      return authorization
                    })
                  }
                >
                  Déconnecter le responsable
                </Button>
              ) : null}
            </div>
            {authorization.requestId &&
            (authorization.status === 'pending' ||
              authorization.status.startsWith('invitation_')) ? (
              <>
                <label className="mt-3 block font-bold">
                  Code d’invitation temporaire
                  <input
                    className={inputStyle}
                    disabled={pending}
                    value={code}
                    autoComplete="off"
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <Button
                  className="mt-2"
                  disabled={pending || !code.trim()}
                  onClick={() => void run(() => service.activate(code))}
                >
                  Activer cette tablette
                </Button>
              </>
            ) : null}
          </details>
        </>
      ) : null}
      {error ? (
        <p className="mt-2 font-bold text-rose-950" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
