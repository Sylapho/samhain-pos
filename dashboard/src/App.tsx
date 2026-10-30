import { useEffect, useState } from 'react'
import type { Filters, Report, SaleRow } from '../../server/src/dashboard/types'
import './style.css'

type Scope = { organizationId: string; festivalId: string; active: boolean }
const money = (cents: number) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100)
const dateTime = (at: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(at))
const paymentName = (name: string) => (name === 'cash' ? 'Espèces' : 'Carte bancaire')
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T12:00:00Z`))
const initial: Filters = { from: '', to: '', terminal: '', payment: '', search: '' }
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { 'X-Samhain-Dashboard': '1' }, signal })
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string }
    throw new Error(error.message ?? 'Impossible de charger les données. Réessayez.')
  }
  return response.json() as Promise<T>
}
export default function App() {
  const [scopes, setScopes] = useState<Scope[]>([])
  const [scopeIndex, setScopeIndex] = useState('')
  const [draft, setDraft] = useState(initial)
  const [filters, setFilters] = useState(initial)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ key: string; data: Report | null; error: string }>({
    key: '',
    data: null,
    error: '',
  })
  const [tablets, setTablets] = useState<Report['tablets']>([])
  const [scopeBusy, setScopeBusy] = useState(true)
  const [scopeError, setScopeError] = useState('')
  const [exportError, setExportError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [scopeRevision, setScopeRevision] = useState(0)
  const scope = scopes[Number(scopeIndex)]
  useEffect(() => {
    const controller = new AbortController()
    get<Scope[]>('/api/scopes', controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return
        setScopes(rows)
        setScopeIndex(rows.length ? '0' : '')
        setScopeBusy(false)
        setScopeError('')
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setScopeError(e instanceof Error ? e.message : 'Connexion impossible.')
          setScopeBusy(false)
        }
      })
    return () => controller.abort()
  }, [scopeRevision])
  const params = new URLSearchParams({
    ...filters,
    organizationId: scope?.organizationId ?? '',
    festivalId: scope?.festivalId ?? '',
    page: String(page),
  }).toString()
  const requestKey = `${params}&revision=${revision}`
  const data = result.key === requestKey ? result.data : null
  const busy = scopeBusy || Boolean(scope && result.key !== requestKey)
  const error = scopeError || (result.key === requestKey ? result.error : '') || exportError
  useEffect(() => {
    if (!scope) return
    const controller = new AbortController()
    // Results are keyed to their filters; previous figures cannot appear under new filters.
    get<Report>(`/api/report?${params}`, controller.signal)
      .then((report) => {
        if (controller.signal.aborted) return
        setResult({ key: requestKey, data: report, error: '' })
        setTablets(report.tablets)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            data: null,
            error: e instanceof Error ? e.message : 'Données indisponibles.',
          })
      })
    return () => controller.abort()
  }, [params, requestKey, scope])
  async function exportSales() {
    setExporting(true)
    setExportError('')
    try {
      const response = await fetch(`/api/report?${params}&format=csv`, {
        headers: { 'X-Samhain-Dashboard': '1' },
      })
      if (!response.ok)
        throw new Error('Export indisponible. Réessayez après avoir actualisé les données.')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = 'ventes-samhain.csv'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export indisponible.')
    } finally {
      setExporting(false)
    }
  }
  const update = (field: keyof Filters, value: string) =>
    setDraft((f) => ({ ...f, [field]: value }))
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Samhain Witches · Suivi des ventes">
          SAMHAIN WITCHES<span>Suivi des ventes</span>
        </a>
        <span className="readonly">Consultation · lecture seule</span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">VUE D’ENSEMBLE</p>
            <h1>Les ventes, en clair.</h1>
            <p className="muted">Retrouvez l’activité du festival et de chaque tablette.</p>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              scopes.length ? setRevision((v) => v + 1) : setScopeRevision((v) => v + 1)
            }
          >
            Actualiser les données
          </button>
        </div>
        <aside className="notice">
          <strong>Ce que vous voyez ici</strong>
          <span>
            Les données reçues dans MongoDB. Une tablette hors ligne peut avoir enregistré d’autres
            ventes qui ne sont pas encore visibles ici. Les heures sont affichées à l’heure de
            Paris.
          </span>
        </aside>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            setFilters({ ...draft })
          }}
        >
          <label className="festival">
            Festival
            <select
              aria-label="Festival"
              value={scopeIndex}
              disabled={!scopes.length || busy}
              onChange={(e) => {
                setScopeIndex(e.target.value)
                setPage(1)
                setFilters(initial)
                setDraft(initial)
                setTablets([])
              }}
            >
              {!scopes.length && <option value="">Aucun festival disponible</option>}
              {scopes.map((s, i) => (
                <option key={`${s.organizationId}/${s.festivalId}`} value={i}>
                  {s.festivalId}
                  {!s.active ? ' (archivé)' : ''} · {s.organizationId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Du
            <input
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => update('from', e.target.value)}
            />
          </label>
          <label>
            Au
            <input
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => update('to', e.target.value)}
            />
          </label>
          <label>
            Tablette
            <select value={draft.terminal} onChange={(e) => update('terminal', e.target.value)}>
              <option value="">Toutes les tablettes</option>
              {tablets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Paiement
            <select value={draft.payment} onChange={(e) => update('payment', e.target.value)}>
              <option value="">Tous les paiements</option>
              <option value="cash">Espèces</option>
              <option value="card">Carte bancaire</option>
            </select>
          </label>
          <label>
            Commande ou reçu
            <input
              type="search"
              maxLength={120}
              placeholder="Ex. A-0001"
              value={draft.search}
              onChange={(e) => update('search', e.target.value)}
            />
          </label>
          <div className="filter-actions">
            <button className="primary" disabled={!scope || busy}>
              Afficher
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(initial)
                setFilters(initial)
                setPage(1)
              }}
            >
              Tout voir
            </button>
          </div>
        </form>
        {error && (
          <div role="alert" className="error">
            <strong>Chargement impossible.</strong> {error}
          </div>
        )}
        <div role="status" aria-live="polite" className="load-status">
          {busy
            ? 'Lecture de la base en cours…'
            : data
              ? `Dernière lecture : ${dateTime(data.generatedAt)} · ${data.saleCount.toLocaleString('fr-FR')} vente(s) correspondant aux filtres.`
              : !error
                ? 'Aucun festival à consulter dans cette base.'
                : ''}
        </div>
        {data && (
          <>
            <section className="metrics" aria-label="Chiffres de la sélection">
              <Metric
                label="Ventes enregistrées"
                value={data.totals.count.toLocaleString('fr-FR')}
                help="Commandes payées, avant corrections"
              />
              <Metric
                label="Montant brut"
                value={money(data.totals.gross)}
                help="Total des ventes de la sélection"
              />
              <Metric
                label="Corrections"
                value={money(data.totals.corrections)}
                help={`${data.totals.correctionCount} remboursement(s), annulation(s) ou ajustement(s)`}
              />
              <Metric
                label="Montant net"
                value={money(data.totals.net)}
                help="Ventes + corrections de la période"
                accent
              />
              <Metric
                label="Panier moyen"
                value={money(data.totals.average)}
                help="Montant brut ÷ nombre de ventes"
              />
            </section>
            {data.totals.legacyCount > 0 && (
              <p className="muted">
                La sélection comprend {data.totals.legacyCount} vente(s) importée(s) de
                l’historique, sans date de réception disponible dans cette vue.
              </p>
            )}
            <div className="grid-two">
              <section className="section">
                <SectionTitle
                  title="Activité par jour"
                  subtitle="Nombre de ventes · date du paiement à Paris"
                />
                {data.days.length ? (
                  <div
                    className="chart"
                    role="img"
                    aria-label={data.days
                      .map((d) => `${dayLabel(d.day)} : ${d.totals.count} ventes`)
                      .join(', ')}
                  >
                    {data.days.map((d) => (
                      <div className="chart-column" key={d.day}>
                        <span>{d.totals.count}</span>
                        <div className="bar-track">
                          <div
                            className="bar"
                            style={{
                              height: `${(d.totals.count / Math.max(1, ...data.days.map((v) => v.totals.count))) * 100}%`,
                            }}
                          />
                        </div>
                        <small>{dayLabel(d.day)}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty text="Aucune activité sur cette période." />
                )}
              </section>
              <section className="section">
                <SectionTitle
                  title="Moyens de paiement"
                  subtitle="Ventes et corrections de la sélection"
                />
                <div className="payment-list">
                  {data.payments.map((p) => (
                    <div className="payment" key={p.name}>
                      <div>
                        <strong>{paymentName(p.name)}</strong>
                        <span>{p.totals.count} vente(s)</span>
                      </div>
                      <div>
                        <strong>{money(p.totals.net)}</strong>
                        <span>
                          Brut {money(p.totals.gross)} · corrections {money(p.totals.corrections)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <section className="section">
              <SectionTitle
                title="Les tablettes"
                subtitle="Touchez « Voir les ventes » pour isoler une tablette. La dernière réception ne prouve pas qu’elle est actuellement connectée."
              />
              {data.tablets.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Tablette</th>
                        <th>Ventes</th>
                        <th>Brut</th>
                        <th>Corrections</th>
                        <th>Net</th>
                        <th>Dernière vente reçue</th>
                        <th>
                          <span className="sr-only">Action</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tablets.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <strong>{t.name}</strong>
                            <small className="identifier">{t.id}</small>
                          </td>
                          <td>{t.totals.count}</td>
                          <td>{money(t.totals.gross)}</td>
                          <td>{money(t.totals.corrections)}</td>
                          <td>
                            <strong>{money(t.totals.net)}</strong>
                          </td>
                          <td>
                            {t.lastReceivedAt ? dateTime(t.lastReceivedAt) : 'Non disponible'}
                          </td>
                          <td>
                            <button
                              aria-label={`Voir les ventes de ${t.name}`}
                              onClick={() => {
                                const f = { ...filters, terminal: t.id }
                                setDraft(f)
                                setFilters(f)
                                setPage(1)
                              }}
                            >
                              Voir les ventes<span className="sr-only"> de {t.name}</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty text="Aucune tablette connue dans les ventes reçues." />
              )}
            </section>
            <section className="section">
              <div className="section-heading">
                <SectionTitle
                  title="Détail des ventes"
                  subtitle="Ouvrez une commande pour voir les articles et leurs options."
                />
                <button disabled={exporting} onClick={() => void exportSales()}>
                  {exporting ? 'Export en cours…' : 'Exporter les ventes (CSV)'}
                </button>
              </div>
              {!data.sales.length ? (
                <Empty text="Aucune vente ne correspond aux filtres. Essayez une autre période ou « Tout voir »." />
              ) : (
                <div className="sales-list">
                  {data.sales.map((s) => (
                    <SaleDetails key={s.id} sale={s} />
                  ))}
                </div>
              )}
              <nav className="pagination" aria-label="Pages des ventes">
                <span>{data.saleCount} vente(s) · 50 par page</span>
                <div>
                  <button disabled={data.page <= 1 || busy} onClick={() => setPage(data.page - 1)}>
                    Précédent
                  </button>
                  <span>
                    Page {data.page} / {data.pageCount}
                  </span>
                  <button
                    disabled={data.page >= data.pageCount || busy}
                    onClick={() => setPage(data.page + 1)}
                  >
                    Suivant
                  </button>
                </div>
              </nav>
            </section>
            <div className="grid-two">
              <section className="section">
                <SectionTitle
                  title="Produits les plus vendus"
                  subtitle="10 premiers noms de produits · quantités brutes avant remboursements"
                />
                {data.products.length ? (
                  <ol className="products">
                    {data.products.map((p) => (
                      <li key={p.name}>
                        <div>
                          <strong>{p.name}</strong>
                          <span>{p.quantity} article(s)</span>
                        </div>
                        <strong>{money(p.cents)}</strong>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty text="Aucun produit vendu dans la sélection." />
                )}
              </section>
              <section className="section">
                <SectionTitle
                  title="Corrections de ventes"
                  subtitle="50 dernières corrections · date de la correction à Paris, même si la vente est antérieure"
                />
                {data.corrections.length ? (
                  <ul className="corrections">
                    {data.corrections.map((c) => (
                      <li key={c.id}>
                        <div>
                          <strong>
                            {c.order} ·{' '}
                            {(
                              {
                                refund: 'Remboursement',
                                cancellation: 'Annulation',
                                adjustment: 'Ajustement',
                              } as Record<string, string>
                            )[c.type] ?? c.type}
                          </strong>
                          <span>
                            {c.tablet} · {dateTime(c.at)} · {paymentName(c.method)}
                          </span>
                          <p>{c.reason}</p>
                        </div>
                        <strong>{money(c.cents)}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty text="Aucune correction dans la sélection." />
                )}
              </section>
            </div>
          </>
        )}
        <footer>
          Samhain Witches · Consultation MongoDB · Aucune modification de la caisse depuis cet écran.
        </footer>
      </main>
    </>
  )
}
function Metric({
  label,
  value,
  help,
  accent = false,
}: {
  label: string
  value: string
  help: string
  accent?: boolean
}) {
  return (
    <div className={`metric${accent ? ' accent' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{help}</small>
    </div>
  )
}
function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2>{title}</h2>
      <p className="muted section-subtitle">{subtitle}</p>
    </div>
  )
}
function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}
function SaleDetails({ sale: s }: { sale: SaleRow }) {
  return (
    <details className="sale">
      <summary>
        <div>
          <strong>{s.number}</strong>
          <span>
            {s.tablet} · {dateTime(s.at)}
          </span>
        </div>
        <div>
          <span>
            {paymentName(s.method)}
            {s.legacy ? ' · Historique' : ''}
          </span>
          <strong>{money(s.cents)}</strong>
          <span className="detail-hint">Voir les articles</span>
        </div>
      </summary>
      <div className="sale-body">
        <p>
          Reçu : <strong>{s.receipt}</strong> · Réception :{' '}
          {s.receivedAt ? dateTime(s.receivedAt) : 'Non disponible (import historique)'}
        </p>
        <ul>
          {s.lines.map((l, i) => (
            <li key={i}>
              <div>
                <strong>
                  {l.quantity} × {l.name}
                </strong>
                {l.details.length > 0 && <span>{l.details.join(' · ')}</span>}
              </div>
              <span>{money(l.unitPriceCents * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <small>Identifiant de vente : {s.id}</small>
      </div>
    </details>
  )
}
