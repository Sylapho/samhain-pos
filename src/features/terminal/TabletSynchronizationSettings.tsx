import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { TabletAuthorization } from '../../native/tabletAuth'
import {
  tabletAuthorizationMessages,
  isEnrollmentUuid,
  tabletEnrollmentService,
  type TabletEnrollmentService,
} from '../../services/tabletEnrollmentService'

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
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [managerAction, setManagerAction] = useState<'approve' | 'reject' | 'revoke' | null>(null)
  const [managerConnected, setManagerConnected] = useState(false)
  const [review, setReview] = useState<Awaited<
    ReturnType<TabletEnrollmentService['inspect']>
  > | null>(null)
  const [reviewedScope, setReviewedScope] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [festivalId, setFestivalId] = useState('')
  const [chainId, setChainId] = useState('')
  const [replacesInstallationId, setReplacesInstallationId] = useState('')
  const [requestedOrganization, setRequestedOrganization] = useState('')
  const [requestedFestival, setRequestedFestival] = useState('')
  const [loaded, setLoaded] = useState(false)
  const newRequest = [
    'rejected',
    'revoked',
    'session_expired',
    'attempts_exceeded',
    'invitation_expired',
    'authorization_denied',
  ].includes(authorization.status)
  const scopeLocked =
    (!!authorization.enrollmentPrepared && !newRequest) ||
    (!!authorization.requestedScope && !newRequest)
  const requestOrganization = scopeLocked
    ? (authorization.requestedScope?.organizationId ?? '')
    : requestedOrganization
  const requestFestival = scopeLocked
    ? (authorization.requestedScope?.festivalId ?? '')
    : requestedFestival
  const validScope = isEnrollmentUuid(requestOrganization) && isEnrollmentUuid(requestFestival)
  useEffect(() => {
    if (service.initialStatus().status === 'not_configured') return
    let active = true
    void service.status().then(
      (value) => {
        if (active) {
          setAuthorization(value)
          setRequestedOrganization(
            value.requestedScope?.organizationId ?? value.organizationId ?? '',
          )
          setRequestedFestival(value.requestedScope?.festivalId ?? value.festivalId ?? '')
          setLoaded(true)
        }
      },
      () => {
        if (active) setError('Impossible de lire l’autorisation. Les ventes restent locales.')
      },
    )
    // The system browser unmounts this screen when the local responsible mode locks.
    // Read only the native session flag after reopening; credentials stay native.
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
  const inputStyle = 'mt-1 min-h-12 w-full border border-stone-400 bg-white px-3 text-stone-950'
  const reviewScope = JSON.stringify([authorization.requestId, organizationId, festivalId, chainId])
  return (
    <div className="mt-4 border-b border-stone-300 pb-3">
      <p className="font-bold" aria-live="polite">
        {tabletAuthorizationMessages[authorization.status]}
      </p>
      <p className="mt-1 text-sm text-stone-700">
        L’autorisation serveur est distincte de la configuration locale. Les ventes et impressions
        fonctionnent sans connexion.
      </p>
      {authorization.status === 'authorized' ? (
        <p className="mt-1 text-sm text-stone-700">
          Dernier état enregistré. Vérifiez la session pour connaître l’état serveur actuel.
        </p>
      ) : null}
      {authorization.status !== 'not_configured' ? (
        <>
          <label className="mt-3 block font-bold">
            Organisation — Identifiant UUID
            <input
              className={inputStyle}
              required
              autoComplete="off"
              spellCheck={false}
              readOnly={scopeLocked}
              disabled={pending || !loaded}
              value={requestOrganization}
              onChange={(event) => setRequestedOrganization(event.target.value)}
              aria-invalid={!!requestOrganization && !isEnrollmentUuid(requestOrganization)}
            />
          </label>
          {requestOrganization && !isEnrollmentUuid(requestOrganization) ? (
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
              value={requestFestival}
              onChange={(event) => setRequestedFestival(event.target.value)}
              aria-invalid={!!requestFestival && !isEnrollmentUuid(requestFestival)}
            />
          </label>
          {requestFestival && !isEnrollmentUuid(requestFestival) ? (
            <p role="alert">L’identifiant du festival doit être un UUID valide.</p>
          ) : null}
          {authorization.requestedScope ? (
            <p className="mt-2 break-all text-sm">
              Périmètre demandé : organisation {authorization.requestedScope.organizationId},
              festival {authorization.requestedScope.festivalId}. L’approbation serveur reste
              obligatoire.
            </p>
          ) : null}
          {newRequest ? (
            <p className="mt-2 text-sm">
              Une nouvelle demande remplacera le dossier d’enrôlement. L’identité et les ventes
              locales sont conservées.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void run(() => service.status(true))}>
              Vérifier / rafraîchir la session
            </Button>
            <Button
              disabled={pending || !loaded || !validScope || authorization.status === 'authorized'}
              onClick={() =>
                void run(() =>
                  service.request({
                    terminalId,
                    organizationId: requestOrganization,
                    festivalId: requestFestival,
                    reconnect: newRequest,
                  }),
                )
              }
            >
              {newRequest
                ? 'Créer une nouvelle demande / reconnecter'
                : 'Demander l’enrôlement / reconnecter'}
            </Button>
          </div>
          {authorization.requestId ? (
            <p className="mt-2 break-all text-sm">
              Demande à faire approuver : {authorization.requestId}
            </p>
          ) : null}
          {authorization.status === 'pending' || authorization.status.startsWith('invitation_') ? (
            <>
              <label className="mt-3 block font-bold">
                Code d’invitation temporaire
                <input
                  className={inputStyle}
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
          <div className="mt-3 flex flex-wrap gap-2">
            {authorization.requestId && authorization.status !== 'authorized' ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setChainId(authorization.chainId ?? '')
                  setOrganizationId(
                    authorization.requestedScope?.organizationId ??
                      authorization.organizationId ??
                      '',
                  )
                  setFestivalId(
                    authorization.requestedScope?.festivalId ?? authorization.festivalId ?? '',
                  )
                  setManagerAction('approve')
                }}
              >
                Approbation par un responsable serveur
              </Button>
            ) : null}
            {authorization.requestId && authorization.status !== 'authorized' ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setChainId(authorization.chainId ?? '')
                  setOrganizationId(
                    authorization.requestedScope?.organizationId ??
                      authorization.organizationId ??
                      '',
                  )
                  setFestivalId(
                    authorization.requestedScope?.festivalId ?? authorization.festivalId ?? '',
                  )
                  setManagerAction('reject')
                }}
              >
                Refuser cette demande
              </Button>
            ) : null}
            {authorization.installationId && authorization.chainId ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setChainId(authorization.chainId ?? '')
                  setOrganizationId(authorization.organizationId ?? '')
                  setFestivalId(authorization.festivalId ?? '')
                  setManagerAction('revoke')
                }}
              >
                Révoquer cette installation
              </Button>
            ) : null}
          </div>
          {managerAction ? (
            <form
              className="mt-3 border-t border-stone-300 pt-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  const result = await service.manager({
                    action: managerAction,
                    body: {
                      chainId,
                      organizationId,
                      festivalId,
                      ...(managerAction !== 'revoke'
                        ? {
                            requestId: authorization.requestId,
                            replacesInstallationId: replacesInstallationId || undefined,
                          }
                        : { installationId: authorization.installationId }),
                    },
                  })
                  return result
                }).then(() => setManagerAction(null))
              }}
            >
              <p className="font-bold">
                {managerAction === 'approve'
                  ? 'Autoriser cette demande'
                  : managerAction === 'reject'
                    ? 'Refuser cette demande'
                    : 'Confirmer la révocation serveur'}
              </p>
              <p className="text-sm">
                Utilisez votre compte responsable dans le navigateur sécurisé. Le PIN local ne donne
                aucun droit serveur.
              </p>
              <Button
                className="mt-2"
                disabled={pending}
                type="button"
                onClick={() =>
                  void run(async () => {
                    setManagerConnected(false)
                    await service.managerLogin()
                    setManagerConnected(true)
                    return authorization
                  })
                }
              >
                {managerConnected
                  ? 'Reconnecter le compte responsable'
                  : 'Se connecter au compte responsable'}
              </Button>
              {managerConnected ? (
                <Button
                  className="mt-2"
                  disabled={pending}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await service.managerLogout()
                      setManagerConnected(false)
                      return authorization
                    })
                  }
                >
                  Déconnecter le responsable
                </Button>
              ) : null}
              {managerAction !== 'revoke' ? (
                <>
                  <label className="mt-2 block">
                    Organisation (identifiant confirmé)
                    <input
                      required
                      className={inputStyle}
                      value={organizationId}
                      readOnly={!!authorization.requestedScope}
                      onChange={(event) => setOrganizationId(event.target.value)}
                    />
                  </label>
                  <label className="mt-2 block">
                    Festival (identifiant confirmé)
                    <input
                      required
                      className={inputStyle}
                      value={festivalId}
                      readOnly={!!authorization.requestedScope}
                      onChange={(event) => setFestivalId(event.target.value)}
                    />
                  </label>
                  <label className="mt-2 block">
                    Chaîne (existante en cas de remplacement)
                    <input
                      required
                      className={inputStyle}
                      value={chainId}
                      onChange={(event) => setChainId(event.target.value)}
                    />
                  </label>
                  <label className="mt-2 block">
                    Installation remplacée (si applicable)
                    <input
                      className={inputStyle}
                      value={replacesInstallationId}
                      onChange={(event) => setReplacesInstallationId(event.target.value)}
                    />
                  </label>
                  <Button
                    className="mt-2"
                    type="button"
                    disabled={pending || !managerConnected || !organizationId || !festivalId}
                    onClick={() =>
                      void run(async () => {
                        setReviewedScope('')
                        const dossier = await service.inspect({
                          requestId: authorization.requestId!,
                          organizationId,
                          festivalId,
                        })
                        if (
                          dossier.installationId !== authorization.installationId ||
                          dossier.chainId !== chainId
                        )
                          throw new Error(
                            'Le dossier ne correspond pas à cette installation et cette chaîne.',
                          )
                        setReview(dossier)
                        setReviewedScope(reviewScope)
                        return authorization
                      })
                    }
                  >
                    Examiner le dossier serveur
                  </Button>
                  {review && reviewedScope === reviewScope ? (
                    <p className="mt-2 text-sm">
                      Caisse déclarée : {review.terminalId}. {review.prefixCount} événements et{' '}
                      {review.legacyCount} commandes historiques.
                      {review.restored
                        ? ' Archive restaurée : vérifier l’installation remplacée et les preuves de sauvegarde.'
                        : ' Installation sans restauration déclarée.'}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="mt-2 font-bold text-amber-950">
                  Les échanges de cette installation seront refusés. Les ventes et données locales
                  restent conservées.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={pending}
                  type="button"
                  onClick={() => {
                    setManagerAction(null)
                  }}
                >
                  Annuler
                </Button>
                <Button
                  disabled={
                    pending ||
                    !managerConnected ||
                    (managerAction !== 'revoke' && reviewedScope !== reviewScope)
                  }
                  type="submit"
                >
                  {managerAction === 'approve'
                    ? 'Autoriser côté serveur'
                    : managerAction === 'reject'
                      ? 'Confirmer le refus'
                      : 'Confirmer la révocation'}
                </Button>
              </div>
            </form>
          ) : null}
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
