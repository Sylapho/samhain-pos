import { useEffect, useRef, useState } from 'react'
import type {
  DashboardSettings,
  Filters,
  Report,
  ExportKind,
} from '../../server/src/dashboard/types'
import { parisDay, shiftDay } from '../../server/src/dashboard/periods'
import { Overview, Analysis, Registers } from './views'
import { dateTime, money } from './format'
import './style.css'

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { 'X-Samhain-Dashboard': '1' }, signal })
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string }
    throw new Error(error.message ?? 'Lecture impossible. Réessayez.')
  }
  return response.json() as Promise<T>
}
type View = 'overview' | 'analysis' | 'registers'
const exports: [ExportKind, string][] = [
  ['orders', 'Commandes'],
  ['lines', 'Lignes vendues'],
  ['products', 'Produits'],
  ['categories', 'Catégories'],
  ['tablets', 'Tablettes'],
  ['corrections', 'Corrections'],
  ['days', 'Journées'],
  ['vat', 'Synthèse TVA'],
]
export default function App() {
  const [settings, setSettings] = useState<DashboardSettings | null>(null),
    [configError, setConfigError] = useState(''),
    [configRevision, setConfigRevision] = useState(0)
  const [filters, setFilters] = useState<Filters | null>(null),
    [page, setPage] = useState(1),
    [correctionPage, setCorrectionPage] = useState(1),
    [revision, setRevision] = useState(0)
  const [view, setView] = useState<View>('overview'),
    [custom, setCustom] = useState({ from: '', to: '' }),
    [refresh, setRefresh] = useState<number | null>(null)
  const [result, setResult] = useState<{
    filterKey: string
    requestKey: string
    data: Report | null
    error: string
  }>({ filterKey: '', requestKey: '', data: null, error: '' })
  const [exportKind, setExportKind] = useState<ExportKind>('orders'),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('')
  const [productSearch, setProductSearch] = useState(''),
    [clock, setClock] = useState(() => Date.now())
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    get<DashboardSettings>('/api/config', controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) {
          setSettings(config)
          setConfigError('')
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setConfigError(e instanceof Error ? e.message : 'Configuration indisponible.')
      })
    return () => controller.abort()
  }, [configRevision])
  const active: Filters | null =
    filters ??
    (settings
      ? {
          ...settings.defaultPeriod,
          terminal: '',
          payment: '',
          search: '',
          productIds: '',
          corrected: 'any',
          compareFrom: '',
          compareTo: '',
        }
      : null)
  const params = active
    ? new URLSearchParams({
        ...active,
        page: String(page),
        correctionPage: String(correctionPage),
      }).toString()
    : ''
  const requestKey = `${params}&request=${revision}`
  const data = result.filterKey === params ? result.data : null
  const busy = Boolean(active && result.requestKey !== requestKey)
  const error = configError || (result.requestKey === requestKey ? result.error : '')
  useEffect(() => {
    if (!params) return
    const controller = new AbortController()
    inFlight.current = controller
    get<Report>(`/api/report?${params}`, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setResult({ filterKey: params, requestKey, data: report, error: '' })
          setClock(Date.now())
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            filterKey: params,
            requestKey,
            data: previous.filterKey === params ? previous.data : null,
            error: e instanceof Error ? e.message : 'Données indisponibles.',
          }))
      })
      .finally(() => {
        if (inFlight.current === controller) inFlight.current = null
      })
    return () => {
      controller.abort()
      if (inFlight.current === controller) inFlight.current = null
    }
  }, [params, requestKey])
  const refreshSeconds = refresh ?? settings?.refreshSeconds ?? 60
  useEffect(() => {
    const update = () => {
      if (!document.hidden && !inFlight.current) setRevision((v) => v + 1)
    }
    const interval = refreshSeconds ? setInterval(update, refreshSeconds * 1000) : undefined
    const timer = setInterval(() => setClock(Date.now()), 15000)
    if (refreshSeconds) document.addEventListener('visibilitychange', update)
    return () => {
      clearInterval(interval)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [refreshSeconds])
  function change(patch: Partial<Filters>) {
    if (active) {
      setFilters({ ...active, ...patch })
      setPage(1)
      setCorrectionPage(1)
      setExportError('')
    }
  }
  function selectPeriod(from: string, to = from) {
    change({ from, to })
    setCustom({ from, to })
  }
  async function download() {
    setExporting(true)
    setExportError('')
    try {
      const response = await fetch(`/api/report?${params}&format=csv&export=${exportKind}`, {
        headers: { 'X-Samhain-Dashboard': '1' },
      })
      if (!response.ok) {
        const e = (await response.json()) as { message?: string }
        throw new Error(e.message ?? 'Export indisponible.')
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a')
      link.href = url
      link.download = `samhain-${exportKind}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export indisponible.')
    } finally {
      setExporting(false)
    }
  }
  const options = result.data?.productOptions ?? []
  const selectedProducts: string[] = JSON.parse(active?.productIds || '[]')
  const stale =
    data && settings && clock - Date.parse(data.generatedAt) > settings.staleMinutes * 60000
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Samhain · Pilotage">
          SAMHAIN<span>Pilotage du festival</span>
        </a>
        <span className="readonly">Consultation publique · lecture seule</span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">ACTIVITÉ COMMERCIALE</p>
            <h1>Le festival, en clair.</h1>
            <p className="muted">Ventes synchronisées de toutes les caisses · heure de Paris.</p>
          </div>
          <button
            disabled={busy}
            onClick={() => (settings ? setRevision((v) => v + 1) : setConfigRevision((v) => v + 1))}
          >
            Actualiser les données
          </button>
        </div>
        <aside className="notice">
          <strong>Données reçues dans MongoDB</strong>
          <span>
            Les tablettes peuvent conserver d’autres ventes hors ligne. La dernière réception ne
            prouve pas une connexion actuelle. Cette consultation est publique, sans
            authentification.
          </span>
        </aside>
        {settings && active && (
          <>
            <section className="periods" aria-label="Période des ventes">
              <div className="quick-days">
                {settings.days.map((d) => (
                  <button
                    key={d.date}
                    aria-pressed={active.from === d.date && active.to === d.date}
                    onClick={() => selectPeriod(d.date)}
                  >
                    {d.label}
                    <small>{d.date.split('-').reverse().slice(0, 2).join('/')}</small>
                  </button>
                ))}
                <button
                  aria-pressed={
                    active.from === settings.days[0].date && active.to === settings.days[3].date
                  }
                  onClick={() => selectPeriod(settings.days[0].date, settings.days[3].date)}
                >
                  Toute la période
                </button>
                <button
                  aria-pressed={active.from === parisDay(new Date()) && active.to === active.from}
                  onClick={() => selectPeriod(parisDay(new Date()))}
                >
                  Aujourd’hui
                </button>
                <button
                  aria-pressed={
                    active.from === shiftDay(parisDay(new Date()), -1) && active.to === active.from
                  }
                  onClick={() => selectPeriod(shiftDay(parisDay(new Date()), -1))}
                >
                  Hier
                </button>
              </div>
              <form
                className="custom-period"
                onSubmit={(e) => {
                  e.preventDefault()
                  selectPeriod(custom.from, custom.to)
                }}
              >
                <span>Personnalisé</span>
                <label>
                  Du
                  <input
                    aria-label="Du"
                    type="date"
                    required
                    max={custom.to || undefined}
                    value={custom.from}
                    onChange={(e) => setCustom((v) => ({ ...v, from: e.target.value }))}
                  />
                </label>
                <label>
                  Au
                  <input
                    aria-label="Au"
                    type="date"
                    required
                    min={custom.from || undefined}
                    value={custom.to}
                    onChange={(e) => setCustom((v) => ({ ...v, to: e.target.value }))}
                  />
                </label>
                <button>Appliquer les dates</button>
              </form>
              <p className="period-label">
                Période sélectionnée :{' '}
                <strong>
                  {active.from} → {active.to}
                </strong>{' '}
                · journées inclusives, Europe/Paris
              </p>
            </section>
            <nav className="view-tabs" aria-label="Vues du dashboard">
              {(
                [
                  ['overview', 'Vue d’ensemble'],
                  ['analysis', 'Analyse des ventes'],
                  ['registers', 'Suivi des caisses'],
                ] as [View, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => setView(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="filters">
              <label>
                Tablette
                <select
                  value={active.terminal}
                  onChange={(e) => change({ terminal: e.target.value })}
                >
                  <option value="">Toutes les tablettes</option>
                  {result.data?.tablets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Paiement
                <select
                  value={active.payment}
                  onChange={(e) => change({ payment: e.target.value })}
                >
                  <option value="">Tous les paiements</option>
                  <option value="cash">Espèces</option>
                  <option value="card">Carte bancaire</option>
                </select>
              </label>
              <label>
                Commande, reçu ou produit
                <input
                  type="search"
                  maxLength={120}
                  value={active.search}
                  onChange={(e) => change({ search: e.target.value })}
                  placeholder="Numéro ou nom historique"
                />
              </label>
              <label>
                Corrections des commandes
                <select
                  value={active.corrected}
                  onChange={(e) => change({ corrected: e.target.value })}
                >
                  <option value="any">Toutes</option>
                  <option value="with">Avec corrections</option>
                  <option value="without">Sans corrections</option>
                </select>
              </label>
              <button
                onClick={() =>
                  change({
                    terminal: '',
                    payment: '',
                    search: '',
                    productIds: '',
                    corrected: 'any',
                  })
                }
              >
                Effacer les filtres
              </button>
            </div>
            <details className="product-picker">
              <summary>
                Filtrer les commandes par produit ·{' '}
                {selectedProducts.length
                  ? `${selectedProducts.length} sélectionné(s)`
                  : 'Tous les produits'}
              </summary>
              <input
                aria-label="Rechercher un produit à sélectionner"
                type="search"
                placeholder="Rechercher un produit"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
              />
              <button onClick={() => change({ productIds: '' })}>Tous les produits</button>
              <div>
                {options
                  .filter((p) =>
                    p.name.toLocaleLowerCase('fr').includes(productSearch.toLocaleLowerCase('fr')),
                  )
                  .map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={selectedProducts.includes(p.id)}
                        onChange={(e) =>
                          change({
                            productIds: JSON.stringify(
                              e.target.checked
                                ? [...selectedProducts, p.id]
                                : selectedProducts.filter((id) => id !== p.id),
                            ),
                          })
                        }
                      />
                      {p.name}
                      <small>{p.id}</small>
                    </label>
                  ))}
              </div>
              <p className="muted">
                Les KPI portent sur les commandes complètes contenant au moins un produit
                sélectionné.
              </p>
            </details>
            {view === 'analysis' && (
              <div className="table-tools">
                <label>
                  Rechercher dans les statistiques produits
                  <input
                    type="search"
                    maxLength={120}
                    value={active.productQuery ?? ''}
                    onChange={(e) => change({ productQuery: e.target.value })}
                  />
                </label>
                <span className="muted">
                  Recherche appliquée aux produits, choix et export des statistiques.
                </span>
              </div>
            )}
            <div className="update-bar">
              <span role="status" aria-live="polite">
                {busy ? 'Actualisation en cours… ' : ''}
                {data
                  ? `Dernière lecture réussie : ${dateTime(data.generatedAt)}`
                  : !error
                    ? 'Lecture de MongoDB…'
                    : ''}
              </span>
              <label>
                Actualisation
                <select value={refreshSeconds} onChange={(e) => setRefresh(Number(e.target.value))}>
                  {[...new Set([0, 30, 60, 120, settings.refreshSeconds])]
                    .sort((a, b) => a - b)
                    .map((s) => (
                      <option key={s} value={s}>
                        {s ? `${s} secondes` : 'Manuelle'}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            <strong>Lecture impossible.</strong> {error}
            {data && ' Les chiffres conservés correspondent à la dernière lecture réussie.'}
          </div>
        )}
        {stale && (
          <div className="error" role="status">
            Les données affichées datent de plus de {settings!.staleMinutes} minutes. Actualisez
            avant de les interpréter.
          </div>
        )}
        {data && settings && active && (
          <>
            {data.warnings.map((w) => (
              <p className="notice" key={w}>
                {w}
              </p>
            ))}
            {view === 'overview' && <Overview data={data} />}
            {view === 'analysis' && (
              <Analysis
                data={data}
                settings={settings}
                onCompare={(date) => change({ compareFrom: date, compareTo: date })}
              />
            )}
            {view === 'registers' && (
              <Registers
                data={data}
                onTablet={(id) => change({ terminal: id })}
                onPage={setPage}
                onCorrectionPage={setCorrectionPage}
                busy={busy}
              />
            )}
            <section className="section export-bar">
              <div>
                <h2>Exporter la sélection</h2>
                <p className="muted">
                  Toutes les lignes filtrées, au-delà de la page visible · CSV pour Excel.
                </p>
              </div>
              <label>
                Type d’export
                <select
                  value={exportKind}
                  onChange={(e) => setExportKind(e.target.value as ExportKind)}
                >
                  {exports.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={exporting || busy} onClick={() => void download()}>
                {exporting ? 'Export en cours…' : 'Télécharger le CSV'}
              </button>
              {exportError && (
                <p role="alert" className="error">
                  {exportError}
                </p>
              )}
            </section>
            <p className="muted">
              Net = ventes payées dans la période + corrections enregistrées dans la période. Une
              correction peut concerner une vente antérieure. Brut sélectionné :{' '}
              {money(data.totals.gross)}.
            </p>
          </>
        )}
        <footer>
          Samhain · Consultation en ligne uniquement · Aucune écriture dans les ventes ou les
          journaux.
        </footer>
      </main>
    </>
  )
}
