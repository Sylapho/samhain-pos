import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { catalogStorage } from '../../native/catalogStorage'
import { apiAuthConfiguration } from '../../config/apiAuthRuntime'
import { readCatalogVersion, validateCatalogContent } from '../../services/catalogDistribution'
import type { CatalogDistributionState } from '../../types/catalogDistribution'
import type { CatalogService } from '../../services/catalogService'
import type { Category, Product } from '../../types/catalog'
import { formatMoney } from '../../utils/money'

const fieldLabels: Record<string, string> = {
  name: 'Nom',
  description: 'Description',
  priceCents: 'Prix',
  vatRate: 'TVA',
  categoryId: 'Catégorie',
  active: 'Actif',
  displayOrder: 'Ordre',
  requiresPreparation: 'Préparation',
  variants: 'Variantes',
  optionGroups: 'Options',
  ingredients: 'Composition',
  dataConfidence: 'Confirmation des données',
  note: 'Note',
}

function displayValue(field: string, value: unknown, categories: Category[]): string {
  if (value === null || value === undefined) return 'Non renseigné'
  if (field === 'priceCents' && typeof value === 'number') return formatMoney(value)
  if (field === 'vatRate' && typeof value === 'number') return `${value} %`
  if (field === 'categoryId' && typeof value === 'string')
    return categories.find(({ id }) => id === value)?.label ?? value
  if (field === 'dataConfidence') return value === 'confirmed' ? 'Confirmé' : 'Temporaire'
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non'
  if (Array.isArray(value))
    return (
      value
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return String(item)
          const row = item as Record<string, unknown>
          const parts = [String(row.name ?? row.id ?? '')]
          if (typeof row.priceCents === 'number') parts.push(formatMoney(row.priceCents))
          if (typeof row.priceDeltaCents === 'number')
            parts.push(`supplément ${formatMoney(row.priceDeltaCents)}`)
          if (typeof row.volume === 'string') parts.push(row.volume)
          if (row.required === true) parts.push('obligatoire')
          if (row.default === true) parts.push('par défaut')
          if (row.options) parts.push(displayValue('options', row.options, categories))
          return parts.join(' · ')
        })
        .join(' ; ') || 'Aucun'
    )
  return String(value)
}

export function CatalogSynchronization({
  service,
  onApply,
  onBusyChanged,
  products,
  categories,
}: {
  service: CatalogService
  onApply: (choice?: 'local' | 'remote') => Promise<void>
  onBusyChanged: (busy: boolean) => void
  products: Product[]
  categories: Category[]
}) {
  const [state, setState] = useState<CatalogDistributionState | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [publish, setPublish] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  useEffect(() => {
    let active = true
    void service.distribution
      .status()
      .then((value) => {
        if (active) setState(value)
      })
      .catch(() => {
        if (active) setError('État local du catalogue indisponible.')
      })
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      active = false
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [service])
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    onBusyChanged(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Échange impossible. Le catalogue local est conservé.',
      )
    } finally {
      try {
        setState(await service.distribution.status())
      } catch {
        setError('État local indisponible. Rechargez l’administration.')
      }
      pending.current = false
      setBusy(false)
      onBusyChanged(false)
    }
  }
  const active = state?.active ? readCatalogVersion(state.active) : null
  const next = state?.pending ? readCatalogVersion(state.pending) : null
  return (
    <section aria-label="Distribution du catalogue" className="space-y-4">
      <p className="font-bold">
        Version locale :{' '}
        {active ? `révision ${active.revision} · ${active.publishedAt}` : 'catalogue local initial'}
      </p>
      <p>
        Les éditions locales restent sur cette tablette. Les ruptures locales ne sont jamais
        publiées.
      </p>
      {!online && (
        <p role="status">
          Hors connexion. La consultation et l’administration locales restent disponibles.
        </p>
      )}
      {state?.error && (
        <p role="status">
          {state.error === 'invalid_download'
            ? 'Téléchargement refusé : version invalide ou obsolète.'
            : 'Synchronisation indisponible.'}{' '}
          Le catalogue local est conservé.
        </p>
      )}
      {error && (
        <p role="alert" className="font-bold text-red-900">
          {error}
        </p>
      )}
      <Button disabled={busy} onClick={() => void run(() => service.distribution.download())}>
        Rechercher une version publiée
      </Button>
      {next && (
        <div className="space-y-3 border-y border-stone-300 py-4">
          <p role="status">
            Révision {next.revision} téléchargée, activation en attente. Terminez tout panier, choix
            d’options et paiement avant l’activation.
          </p>
          <Button
            disabled={busy || !!state?.conflicts.length}
            onClick={() => void run(() => onApply())}
          >
            Activer la version téléchargée
          </Button>
        </div>
      )}
      {!!state?.conflicts.length && (
        <div className="space-y-3 border-y border-amber-400 py-4">
          <p className="font-bold">Conflits : les valeurs locales sont conservées.</p>
          <ul className="space-y-2">
            {state.conflicts.map((conflict) => (
              <li key={`${conflict.entity}:${conflict.id}:${conflict.field}`}>
                <strong>
                  {(conflict.entity === 'products'
                    ? products.find(({ id }) => id === conflict.id)?.name
                    : categories.find(({ id }) => id === conflict.id)?.label) ?? conflict.id}{' '}
                  · {fieldLabels[conflict.field] ?? conflict.field}
                </strong>
                <p className="break-words">
                  Local : {displayValue(conflict.field, conflict.local, categories)} · Publié :{' '}
                  {displayValue(conflict.field, conflict.remote, state.base.categories)}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void run(() => onApply('local'))}>
              Conserver toutes les valeurs locales
            </Button>
            <Button disabled={busy} onClick={() => void run(() => onApply('remote'))}>
              Accepter toutes les valeurs publiées
            </Button>
          </div>
          <p>La décision est enregistrée sur cette tablette. Elle ne publie aucune modification.</p>
        </div>
      )}
      <p>{state?.decisions.length ?? 0} décision(s) locale(s) enregistrée(s).</p>
      {catalogStorage.isAndroidNative() && apiAuthConfiguration.status !== 'not_configured' ? (
        <p>
          La publication centrale du catalogue pour cette destination API n’est pas encore
          disponible. Le catalogue local reste utilisable.
        </p>
      ) : null}
      {catalogStorage.isAndroidNative() && apiAuthConfiguration.status === 'not_configured' && (
        <>
          <Button
            disabled={busy || !!next || !!state?.conflicts.length}
            onClick={() => setPublish(!publish)}
          >
            Proposer une publication centrale
          </Button>
          {publish && (
            <form
              className="space-y-3 border-t border-stone-300 pt-4"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  const content = validateCatalogContent(
                    await service.distribution.publicationContent(),
                  )
                  const scope = await catalogStorage.getPublicationScope()
                  if (!scope.organizationId || !scope.festivalId)
                    throw new Error('Enrôlez la tablette avant de publier.')
                  const { version } = await catalogStorage.publishCatalog({
                    email,
                    password,
                    body: {
                      ...content,
                      organizationId: scope.organizationId,
                      festivalId: scope.festivalId,
                      expectedRevision: active?.revision ?? 0,
                    },
                  })
                  setPassword('')
                  setPublish(false)
                  await service.distribution.stage(version, {
                    organizationId: scope.organizationId,
                    festivalId: scope.festivalId,
                  })
                }).finally(() => setPassword(''))
              }}
            >
              <p>
                Publication globale explicite avec un compte Supabase habilité. Le PIN local ne
                suffit pas. Les données commerciales doivent être confirmées ; le serveur refuse une
                révision dépassée.
              </p>
              <label className="block">
                Compte Supabase
                <input
                  className="ml-3 min-h-12 border p-2"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="block">
                Mot de passe
                <input
                  className="ml-3 min-h-12 border p-2"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Publier les modifications sur toutes les tablettes
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
