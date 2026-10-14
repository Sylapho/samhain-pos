import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { TabletAuthorization } from '../../native/tabletAuth'
import {
  tabletAuthorizationMessages,
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
  const [managerAction, setManagerAction] = useState<'approve' | 'revoke' | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [festivalId, setFestivalId] = useState('')
  const [chainId, setChainId] = useState('')
  const [replacesInstallationId, setReplacesInstallationId] = useState('')
  useEffect(() => {
    if (service.initialStatus().status === 'not_configured') return
    let active = true
    void service.status().then(
      (value) => {
        if (active) setAuthorization(value)
      },
      () => {
        if (active) setError('Impossible de lire l’autorisation. Les ventes restent locales.')
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
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Vérification impossible. Les ventes locales sont conservées.',
      )
    } finally {
      busy.current = false
      setPending(false)
      setPassword('')
      setCode('')
    }
  }
  const inputStyle = 'mt-1 min-h-12 w-full border border-stone-400 bg-white px-3 text-stone-950'
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
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void run(() => service.status(true))}>
              Vérifier / rafraîchir la session
            </Button>
            <Button
              disabled={pending || authorization.status === 'authorized'}
              onClick={() =>
                void run(() =>
                  service.request(
                    terminalId,
                    [
                      'session_expired',
                      'needs_recovery',
                      'revoked',
                      'authorization_denied',
                      'attempts_exceeded',
                    ].includes(authorization.status),
                  ),
                )
              }
            >
              Demander l’enrôlement / reconnecter
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
            {authorization.requestId ? (
              <Button
                disabled={pending}
                onClick={() => {
                  setChainId(authorization.chainId ?? '')
                  setManagerAction('approve')
                }}
              >
                Approbation par un responsable serveur
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
          </div>
          {managerAction ? (
            <form
              className="mt-3 border-t border-stone-300 pt-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  const result = await service.manager({
                    action: managerAction,
                    email,
                    password,
                    body: {
                      chainId,
                      ...(managerAction === 'approve'
                        ? {
                            requestId: authorization.requestId,
                            organizationId,
                            festivalId,
                            replacesInstallationId: replacesInstallationId || undefined,
                          }
                        : { installationId: authorization.installationId }),
                    },
                  })
                  if (result.invitationCode) return service.activate(result.invitationCode)
                  return result
                }).then(() => setManagerAction(null))
              }}
            >
              <p className="font-bold">
                {managerAction === 'approve'
                  ? 'Autoriser cette demande'
                  : 'Confirmer la révocation serveur'}
              </p>
              <p className="text-sm">
                Utilisez un compte Supabase habilité. Le PIN local ne donne aucun droit serveur.
              </p>
              <label className="mt-2 block">
                Adresse du compte responsable
                <input
                  type="email"
                  required
                  className={inputStyle}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="mt-2 block">
                Mot de passe
                <input
                  type="password"
                  required
                  autoComplete="off"
                  className={inputStyle}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {managerAction === 'approve' ? (
                <>
                  <label className="mt-2 block">
                    Organisation (identifiant confirmé)
                    <input
                      required
                      className={inputStyle}
                      value={organizationId}
                      onChange={(event) => setOrganizationId(event.target.value)}
                    />
                  </label>
                  <label className="mt-2 block">
                    Festival (identifiant confirmé)
                    <input
                      required
                      className={inputStyle}
                      value={festivalId}
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
                    setPassword('')
                    setManagerAction(null)
                  }}
                >
                  Annuler
                </Button>
                <Button disabled={pending} type="submit">
                  {managerAction === 'approve'
                    ? 'Autoriser côté serveur'
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
