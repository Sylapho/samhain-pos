import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  DashboardSettings,
  Report,
  Totals,
  ProductRow,
  PublicCorrection,
} from '../../server/src/dashboard/types'

import { money, dateTime } from './format'
const percent = (v: number | null) =>
  v === null
    ? 'Indisponible'
    : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(v)} %`
const number = (v: number | null) =>
  v === null
    ? 'Indisponible'
    : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v)
const payment = (v: string) => (v === 'cash' ? 'Espèces' : 'Carte bancaire')
const correctionType = (v: string) =>
  (
    ({ refund: 'Remboursement', cancellation: 'Annulation', adjustment: 'Ajustement' }) as Record<
      string,
      string
    >
  )[v] ?? v
function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {note && <p className="muted section-subtitle">{note}</p>}
      {children}
    </section>
  )
}
function Table({
  headers,
  rows,
  label,
}: {
  headers: string[]
  rows: ReactNode[][]
  label: string
}) {
  return (
    <div className="table-scroll">
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty">Aucune donnée dans cette sélection.</p>}
    </div>
  )
}
function Metric({
  title,
  value,
  note,
  accent = false,
}: {
  title: string
  value: string
  note: string
  accent?: boolean
}) {
  return (
    <div className={`metric${accent ? ' accent' : ''}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  )
}
export function Indicators({ t }: { t: Totals }) {
  return (
    <section className="metrics" aria-label="Chiffres de la sélection">
      <Metric title="Commandes payées" value={number(t.count)} note="Avant corrections" />
      <Metric title="Chiffre d’affaires brut" value={money(t.gross)} note="Ventes de la période" />
      <Metric title="Corrections" value={money(t.corrections)} note="Somme signée de la période" />
      <Metric
        title="Chiffre d’affaires net"
        value={money(t.net)}
        note="Brut + corrections"
        accent
      />
      <Metric title="Panier moyen" value={money(t.average)} note="Brut ÷ commandes" />
      <Metric
        title="Articles vendus"
        value={number(t.articles)}
        note="Quantité brute avant retours"
      />
      <Metric
        title="Articles par commande"
        value={number(t.articlesAverage)}
        note="Quantité brute ÷ commandes"
      />
    </section>
  )
}
function Bars({
  title,
  values,
  reference,
}: {
  title: string
  values: { label: string; totals: Totals }[]
  reference?: Totals[]
}) {
  const [measure, setMeasure] = useState<'count' | 'gross' | 'net'>('count')
  const all = [
      ...values.map((v) => v.totals[measure]),
      ...(reference?.map((v) => v[measure]) ?? []),
    ],
    max = Math.max(1, ...all.map(Math.abs))
  const chartWidth = Math.max(720, values.length * 30)
  const peak = Math.max(...values.map((v) => v.totals[measure]), 0),
    width = chartWidth / Math.max(1, values.length)
  const negative = all.some((v) => v < 0),
    baseline = negative ? 150 : 250,
    scale = negative ? 120 : 200
  return (
    <Panel
      title={title}
      note={
        measure === 'count'
          ? 'Commandes payées. Les heures répétées au changement d’heure sont cumulées.'
          : `${measure === 'gross' ? 'Montants bruts des ventes' : 'Montants nets avec corrections à leur date d’enregistrement'}. Europe/Paris.`
      }
    >
      <div className="chart-toolbar" role="group" aria-label={`Mesure : ${title}`}>
        {(
          [
            ['count', 'Commandes'],
            ['gross', 'Brut'],
            ['net', 'Net'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} aria-pressed={measure === id} onClick={() => setMeasure(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="svg-chart">
        <svg
          viewBox={`0 0 ${chartWidth + 20} 310`}
          style={{ minWidth: values.length > 24 ? chartWidth + 20 : 600 }}
          role="img"
          aria-label={`${title} : ${values.map((v) => `${v.label}, ${measure === 'count' ? number(v.totals[measure]) : money(v.totals[measure])}`).join(' ; ')}`}
        >
          <line x1="10" y1={baseline} x2={chartWidth + 10} y2={baseline} stroke="#a8b4ac" />
          {values.map((v, i) => {
            const amount = v.totals[measure],
              h = (Math.abs(amount) / max) * scale
            return (
              <g key={v.label}>
                <rect
                  x={12 + i * width}
                  y={amount >= 0 ? baseline - h : baseline}
                  width={width * (reference ? 0.38 : 0.75)}
                  height={h}
                  className={peak > 0 && amount === peak ? 'peak-bar' : 'series-bar'}
                >
                  <title>
                    {v.label} : {measure === 'count' ? number(amount) : money(amount)}
                  </title>
                </rect>
                {reference && (
                  <rect
                    x={12 + i * width + width * 0.4}
                    y={
                      reference[i][measure] >= 0
                        ? baseline - (Math.abs(reference[i][measure]) / max) * scale
                        : baseline
                    }
                    width={width * 0.38}
                    height={(Math.abs(reference[i][measure]) / max) * scale}
                    className="reference-bar"
                  />
                )}
                <text x={12 + i * width + width * 0.35} y="300" textAnchor="middle">
                  {v.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="muted">
        {peak > 0
          ? `Pic : ${values
              .filter((v) => v.totals[measure] === peak)
              .map((v) => v.label)
              .join(', ')} · ${measure === 'count' ? number(peak) + ' commandes' : money(peak)}`
          : 'Aucune valeur positive dans cette sélection.'}
        {reference && ' · Vert : période sélectionnée. Gris : référence.'}
      </p>
      <details className="chart-data">
        <summary>Voir les valeurs · {title}</summary>
        <Table
          label={`Valeurs : ${title}`}
          headers={['Période', 'Sélection', ...(reference ? ['Référence'] : [])]}
          rows={values.map((v, i) => [
            v.label,
            measure === 'count' ? number(v.totals[measure]) : money(v.totals[measure]),
            ...(reference
              ? [measure === 'count' ? number(reference[i][measure]) : money(reference[i][measure])]
              : []),
          ])}
        />
      </details>
    </Panel>
  )
}
function Payments({ data }: { data: Report }) {
  const card = data.payments.find((p) => p.name === 'card')?.share ?? 0
  return (
    <Panel
      title="Moyens de paiement"
      note="Parts en nombre de commandes. Brut, corrections et net restent distincts."
    >
      <div className="payment-overview">
        <svg
          viewBox="0 0 120 120"
          role="img"
          aria-label={`${percent(card)} des commandes par carte`}
        >
          <circle cx="60" cy="60" r="44" fill="none" stroke="#afbcaa" strokeWidth="15" />
          <circle
            cx="60"
            cy="60"
            r="44"
            fill="none"
            stroke="#23563c"
            strokeWidth="15"
            pathLength="100"
            strokeDasharray={`${card} ${100 - card}`}
            transform="rotate(-90 60 60)"
          />
          <text x="60" y="63" textAnchor="middle">
            {number(data.totals.count)}
          </text>
        </svg>
        <Table
          label="Répartition des paiements"
          headers={['Paiement', 'Commandes', 'Part', 'Brut', 'Corrections', 'Net']}
          rows={data.payments.map((p) => [
            payment(p.name),
            number(p.totals.count),
            percent(p.share),
            money(p.totals.gross),
            money(p.totals.corrections),
            money(p.totals.net),
          ])}
        />
      </div>
    </Panel>
  )
}
export function Overview({ data }: { data: Report }) {
  return (
    <>
      <Indicators t={data.totals} />
      <div className="grid-two">
        <Bars
          title="Activité par journée"
          values={data.days.map((d) => ({ label: d.day.slice(5), totals: d.totals }))}
        />
        <Payments data={data} />
      </div>
      <Panel
        title="Comparaison de période"
        note={`${data.filters.from} → ${data.filters.to}, comparé à ${data.comparison.from} → ${data.comparison.to}. Les mêmes filtres sont appliqués.`}
      >
        {!data.comparison.available && (
          <p className="notice">
            Aucune activité synchronisée dans la période de référence : comparaison en pourcentage
            indisponible.
          </p>
        )}
        <Table
          label="Écarts de période"
          headers={['Indicateur', 'Écart absolu', 'Évolution']}
          rows={data.comparison.differences.map((d) => [
            {
              gross: 'Chiffre d’affaires brut',
              count: 'Commandes',
              average: 'Panier moyen',
              articles: 'Articles bruts',
            }[d.key],
            d.key === 'gross' || d.key === 'average' ? money(d.absolute) : number(d.absolute),
            data.comparison.available ? percent(d.percent) : 'Indisponible',
          ])}
        />
      </Panel>
      {data.goals.length > 0 && (
        <Panel
          title="Objectifs de chiffre d’affaires"
          note="Objectifs configurés côté serveur. Mesure brute, indépendamment des filtres tablette, produit et paiement."
        >
          {data.goals.map((g) => (
            <div className="goal" key={g.label}>
              <div>
                <strong>{g.label}</strong>
                <span>
                  {money(g.actual)} / {money(g.target)} · {percent(g.percent)} · reste{' '}
                  {money(g.remaining)}
                </span>
              </div>
              <progress max={g.target} value={Math.min(g.actual, g.target)} aria-label={g.label} />
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Informations opérationnelles">
        <ul className="alerts">
          {data.tablets
            .filter((t) => t.warning)
            .map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong> : {t.warning}
              </li>
            ))}
          <li>
            Événements encore en attente sur les tablettes : <strong>Indisponible</strong>. Le
            serveur ne connaît pas leur file locale.
          </li>
          <li>Aucune absence de réception n’est interprétée comme une déconnexion.</li>
        </ul>
      </Panel>
    </>
  )
}
function Products({ data }: { data: Report }) {
  const query = data.filters.productQuery ?? ''
  const [sort, setSort] = useState('quantity'),
    [page, setPage] = useState(1),
    [size, setSize] = useState(25)
  const rows = data.products
    .filter((p) =>
      p.names.some((n) => n.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr'))),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'fr')
        : sort === 'revenue'
          ? b.cents - a.cents
          : b.quantity - a.quantity,
    )
  const pages = size ? Math.max(1, Math.ceil(rows.length / size)) : 1,
    current = Math.min(page, pages),
    visible = size ? rows.slice((current - 1) * size, current * size) : rows
  return (
    <Panel
      title="Statistiques de tous les produits"
      note="Regroupement par identifiant historique, jamais par le catalogue actuel. Le net est un flux de la période ; un retour d’une vente antérieure peut le rendre négatif."
    >
      <div className="table-tools">
        <label>
          Trier les produits
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="quantity">Quantité brute</option>
            <option value="revenue">Chiffre d’affaires brut</option>
            <option value="name">Ordre alphabétique</option>
          </select>
        </label>
        <label>
          Produits par page
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value))
              setPage(1)
            }}
          >
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="0">Tous</option>
          </select>
        </label>
      </div>
      <Table
        label="Statistiques produits"
        headers={[
          'Produit historique',
          'Quantité brute',
          'Quantité nette',
          'Brut',
          'Net',
          'Part quantités',
          'Part brut',
          'Commandes',
        ]}
        rows={visible.map((p) => [
          <ProductName key={p.id} product={p} />,
          number(p.quantity),
          number(p.netQuantity),
          money(p.cents),
          money(p.netCents),
          percent(p.quantityShare),
          percent(p.revenueShare),
          number(p.orderCount),
        ])}
      />
      <Pager label="Produits" page={current} pages={pages} total={rows.length} onChange={setPage} />
    </Panel>
  )
}
function ProductName({ product: p }: { product: ProductRow }) {
  return (
    <span>
      <strong>{p.name}</strong>
      <small className="identifier">{p.id}</small>
      {p.names.length > 1 && <small>Noms conservés : {p.names.join(' · ')}</small>}
    </span>
  )
}
export function Analysis({
  data,
  settings,
  onCompare,
}: {
  data: Report
  settings: DashboardSettings
  onCompare: (date: string) => void
}) {
  const singleDay = data.filters.from === data.filters.to
  return (
    <>
      <Bars
        title={
          singleDay ? 'Ventes par heure · 00h à 23h' : 'Ventes par heure · cumul de la sélection'
        }
        values={data.hours.map((h) => ({ label: `${h.hour}h`, totals: h.totals }))}
        reference={
          data.comparison.available ? data.comparison.hours.map((h) => h.totals) : undefined
        }
      />
      <Panel
        title="Comparer les journées"
        note="Pour comparer deux journées du festival, sélectionnez d’abord une journée dans la barre supérieure, puis sa référence ici."
      >
        <label>
          Journée de référence
          <select
            value={data.filters.compareFrom ?? ''}
            onChange={(e) => onCompare(e.target.value)}
          >
            <option value="">Période précédente de même durée</option>
            {settings.days.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label} · {d.date}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          Référence active : {data.comparison.from} → {data.comparison.to}.{' '}
          {singleDay
            ? 'Comparaison horaire sur une journée.'
            : 'Les heures de chaque période sont cumulées.'}
        </p>
      </Panel>
      <Bars
        title="Évolution des quatre journées du festival"
        values={data.festival.map((d, i) => ({ label: settings.days[i].label, totals: d.totals }))}
      />
      <Panel
        title="Cumuls du festival"
        note="Mêmes filtres de tablette, paiement, recherche et produit ; les quatre dates restent visibles."
      >
        <Table
          label="Cumuls par journée"
          headers={[
            'Journée',
            'Commandes',
            'Brut',
            'Net',
            'Commandes cumulées',
            'Brut cumulé',
            'Net cumulé',
          ]}
          rows={data.festival.map((d) => [
            d.day,
            number(d.totals.count),
            money(d.totals.gross),
            money(d.totals.net),
            number(d.cumulativeCount),
            money(d.cumulativeGross),
            money(d.cumulativeNet),
          ])}
        />
      </Panel>
      <Products data={data} />
      <Panel title="Analyse des catégories">
        <p className="empty">Indisponible. {data.categories.reason}</p>
      </Panel>
      <Panel
        title="Variantes, options et ingrédients retirés"
        note="Sélections brutes pondérées par la quantité de la ligne. Les prix des options sont déjà inclus dans les lignes : aucun supplément n’est ajouté au chiffre d’affaires."
      >
        <Table
          label="Variantes et options historiques"
          headers={['Produit', 'Type', 'Choix historique', 'Sélections brutes', 'Supplément']}
          rows={data.choices.map((c) => [
            c.productName,
            { variant: 'Variante', option: 'Option', removed: 'Ingrédient retiré' }[c.kind],
            c.name,
            number(c.quantity),
            c.supplement ? 'Oui' : '—',
          ])}
        />
      </Panel>
      <Payments data={data} />
      <Panel
        title="Synthèse TVA"
        note="Snapshots immuables, arrondi par ligne conforme au projet. Consultation fiscale sans certification comptable. Corrections sélectionnées à leur date d’enregistrement."
      >
        {!data.tax.complete && (
          <p className="notice">
            {data.tax.unallocatedCorrections} correction(s) insuffisamment détaillée(s). La
            ventilation nette par taux est indisponible.
          </p>
        )}
        <Table
          label="TVA par taux"
          headers={[
            'Taux',
            'Ventes TTC',
            'Ventes HT',
            'TVA ventes',
            'Corrections TTC',
            'Net TTC',
            'Net HT',
            'Net TVA',
          ]}
          rows={[
            ...data.tax.rows.map((t) => [
              `${t.rate} %`,
              money(t.gross),
              money(t.excludingVat),
              money(t.vat),
              money(t.corrections),
              money(t.net),
              money(t.netExcludingVat),
              money(t.netVat),
            ]),
            [
              'Total',
              money(data.tax.total.gross),
              money(data.tax.total.excludingVat),
              money(data.tax.total.vat),
              money(data.tax.total.corrections),
              money(data.tax.total.net),
              money(data.tax.total.netExcludingVat),
              money(data.tax.total.netVat),
            ],
          ]}
        />
      </Panel>
    </>
  )
}
function Pager({
  label,
  page,
  pages,
  total,
  onChange,
  busy = false,
}: {
  label: string
  page: number
  pages: number
  total: number
  onChange: (page: number) => void
  busy?: boolean
}) {
  return (
    <nav className="pagination" aria-label={`Pages ${label}`}>
      <span>{number(total)} résultat(s)</span>
      <div>
        <button
          aria-label={`${label} : précédent`}
          disabled={page <= 1 || busy}
          onClick={() => onChange(page - 1)}
        >
          Précédent
        </button>
        <span>
          Page {page} / {pages}
        </span>
        <button
          aria-label={`${label} : suivant`}
          disabled={page >= pages || busy}
          onClick={() => onChange(page + 1)}
        >
          Suivant
        </button>
      </div>
    </nav>
  )
}
function Correction({ c }: { c: PublicCorrection }) {
  return (
    <li>
      <div>
        <strong>
          {c.order} · {correctionType(c.type)}
        </strong>
        <span>
          {dateTime(c.at)} · {c.tablet} · {payment(c.method)}
        </span>
        <p>{c.reason}</p>
        {c.refundLines && (
          <span>{c.refundLines.map((l) => `${l.quantity} × ${l.productName}`).join(' · ')}</span>
        )}
      </div>
      <strong>{money(c.cents)}</strong>
    </li>
  )
}
export function Registers({
  data,
  onTablet,
  onPage,
  onCorrectionPage,
  busy,
}: {
  data: Report
  onTablet: (id: string) => void
  onPage: (page: number) => void
  onCorrectionPage: (page: number) => void
  busy: boolean
}) {
  const selected = data.tablets.find((t) => t.id === data.filters.terminal)
  return (
    <>
      <Panel
        title="Comparatif des tablettes"
        note="Caisses identifiables dans les ventes reçues, pas un inventaire des installations ni un contrôle de présence."
      >
        <Table
          label="Comparatif des tablettes"
          headers={[
            'Tablette',
            'Commandes',
            'Articles',
            'Brut',
            'Corrections',
            'Net',
            'Panier moyen',
            'Action',
          ]}
          rows={data.tablets.map((t) => [
            t.name,
            number(t.totals.count),
            number(t.totals.articles),
            money(t.totals.gross),
            money(t.totals.corrections),
            money(t.totals.net),
            money(t.totals.average),
            <button
              key={t.id}
              aria-label={`Voir les ventes de ${t.name}`}
              onClick={() => onTablet(t.id)}
            >
              Voir les ventes
            </button>,
          ])}
        />
      </Panel>
      <Panel
        title={selected ? `Suivi · ${selected.name}` : 'Réceptions et synchronisation'}
        note="Dernières réceptions observables, toutes dates confondues. Aucun jeton, clé ou identifiant d’authentification n’est exposé."
      >
        {selected && <p className="muted">Identifiant de la tablette : {selected.id}</p>}
        <Table
          label="Réceptions des tablettes"
          headers={[
            'Tablette',
            'Dernière vente reçue',
            'Dernière synchronisation observée',
            'Événements en attente',
            'Observation',
          ]}
          rows={(selected ? [selected] : data.tablets).map((t) => [
            t.name,
            dateTime(t.lastReceivedAt),
            dateTime(t.lastSyncAt),
            'Indisponible',
            t.warning ?? 'Aucune anomalie confirmée disponible',
          ])}
        />
        {selected && (
          <Table
            label="Paiements de la tablette"
            headers={['Paiement', 'Commandes', 'Brut', 'Corrections', 'Net']}
            rows={selected.payments.map((p) => [
              payment(p.name),
              number(p.totals.count),
              money(p.totals.gross),
              money(p.totals.corrections),
              money(p.totals.net),
            ])}
          />
        )}
      </Panel>
      <Panel
        title="Historique des commandes"
        note="Les filtres du haut s’appliquent à toutes les commandes. Le montant corrigé inclut toutes les corrections connues, même hors de la période sélectionnée."
      >
        {!data.sales.length && <p className="empty">Aucune commande ne correspond aux filtres.</p>}
        <div className="sales-list">
          {data.sales.map((s) => (
            <details className="sale" key={s.id}>
              <summary>
                <div>
                  <strong>{s.number}</strong>
                  <span>
                    {s.tablet} · {dateTime(s.at)}
                  </span>
                </div>
                <div>
                  <span>
                    {payment(s.method)}
                    {s.legacy ? ' · Historique' : ''}
                  </span>
                  <strong>{money(s.cents)}</strong>
                  <span className="detail-hint">Voir les articles et corrections</span>
                </div>
              </summary>
              <div className="sale-body">
                <p>
                  Reçu : <strong>{s.receipt}</strong> · Réception MongoDB : {dateTime(s.receivedAt)}
                </p>
                <ul>
                  {s.lines.map((l) => (
                    <li key={l.lineId}>
                      <div>
                        <strong>
                          {l.quantity} × {l.name}
                        </strong>
                        <span>{l.details.join(' · ')}</span>
                      </div>
                      <span>{money(l.quantity * l.unitPriceCents)}</span>
                    </li>
                  ))}
                </ul>
                <p>
                  Montant initial : {money(s.cents)} · Après corrections connues :{' '}
                  <strong>{money(s.correctedCents)}</strong>
                </p>
                <ul className="corrections">
                  {s.corrections.map((c) => (
                    <Correction key={c.id} c={c} />
                  ))}
                </ul>
                {!s.corrections.length && <p>Aucune correction connue.</p>}
              </div>
            </details>
          ))}
        </div>
        <Pager
          label="Commandes"
          page={data.page}
          pages={data.pageCount}
          total={data.saleCount}
          onChange={onPage}
          busy={busy}
        />
      </Panel>
      <Panel
        title="Historique des corrections"
        note="Date de correction, distincte de la date du paiement. Pagination indépendante des commandes."
      >
        <ul className="corrections">
          {data.corrections.map((c) => (
            <Correction key={`${c.originalId}/${c.id}`} c={c} />
          ))}
        </ul>
        {!data.corrections.length && (
          <p className="empty">Aucune correction dans cette sélection.</p>
        )}
        <Pager
          label="Corrections"
          page={data.correctionPage}
          pages={data.correctionPageCount}
          total={data.correctionCount}
          onChange={onCorrectionPage}
          busy={busy}
        />
      </Panel>
    </>
  )
}
