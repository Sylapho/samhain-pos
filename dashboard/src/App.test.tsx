import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'
import { festivalDays, parisDay, shiftDay } from '../../server/src/dashboard/periods'
import type { DashboardSettings, Filters, Report } from '../../server/src/dashboard/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const settings: DashboardSettings = {
  days: festivalDays('2026-10-22'),
  defaultPeriod: { from: '2026-10-22', to: '2026-10-25' },
  timeZone: 'Europe/Paris',
  refreshSeconds: 60,
  staleMinutes: 10,
  goals: { daily: null, festival: null },
}
function fixture(params = new URLSearchParams(), count = 1): Report {
  const totals = {
    count,
    gross: count * 202,
    corrections: 0,
    net: count * 202,
    average: 202,
    articles: count * 2,
    articlesAverage: 2,
  }
  const filters: Filters = {
    from: params.get('from') ?? settings.defaultPeriod.from,
    to: params.get('to') ?? settings.defaultPeriod.to,
    terminal: params.get('terminal') ?? '',
    search: '',
    payment: '',
    corrected: 'any',
    productIds: '',
  }
  return {
    generatedAt: new Date().toISOString(),
    filters,
    totals: { ...totals, correctionCount: 0, legacyCount: 1 },
    tablets: [
      {
        id: 'tablet-a',
        name: 'Tablette A',
        totals,
        payments: [{ name: 'cash', totals }],
        lastReceivedAt: null,
        lastSyncAt: null,
        pending: null,
        warning: null,
      },
    ],
    payments: [{ name: 'cash', totals, share: 100 }],
    days: [],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, totals: { ...totals, count: 0 } })),
    festival: [],
    comparison: {
      from: '2026-10-18',
      to: '2026-10-21',
      totals,
      hours: [],
      available: false,
      differences: [],
    },
    productOptions: [{ id: 'test-1', name: 'Produit test' }],
    products: [],
    choices: [],
    categories: { available: false, reason: 'Catégories historiques absentes.' },
    tax: {
      rows: [],
      total: {
        gross: 0,
        excludingVat: 0,
        vat: 0,
        corrections: 0,
        correctionVat: 0,
        net: 0,
        netExcludingVat: 0,
        netVat: 0,
      },
      complete: true,
      unallocatedCorrections: 0,
    },
    warnings: [],
    goals: [],
    sales: [
      {
        id: 'sale-1',
        number: 'A-0001',
        receipt: 'RECU-1',
        terminalId: 'tablet-a',
        tablet: 'Tablette A',
        at: '2026-10-25T12:00:00Z',
        day: '2026-10-25',
        hour: 13,
        receivedAt: null,
        method: 'cash',
        cents: 202,
        legacy: true,
        correctedCents: 202,
        corrections: [],
        lines: [
          {
            lineId: 'l1',
            productId: 'test-1',
            name: 'Produit test',
            quantity: 2,
            unitPriceCents: 101,
            vatRate: 10,
            details: ['Option test'],
            variant: null,
            options: [],
            removed: [],
          },
        ],
      },
    ],
    corrections: [],
    page: Number(params.get('page') ?? 1),
    pageCount: 2,
    saleCount: 51,
    correctionCount: 0,
    correctionPage: Number(params.get('correctionPage') ?? 1),
    correctionPageCount: 1,
  }
}
const response = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response
function fetchMock(handler?: (params: URLSearchParams) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string) =>
    url === '/api/config'
      ? response(settings)
      : handler
        ? handler(new URL(url, 'https://test.local').searchParams)
        : response(fixture(new URL(url, 'https://test.local').searchParams)),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}
describe('dashboard single festival', () => {
  it('loads one server configuration, preserves filters across views and applies all date shortcuts', async () => {
    const fetcher = fetchMock()
    render(<App />)
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    expect(screen.queryByLabelText('Festival')).toBeNull()
    for (const [label, date] of settings.days.map((d) => [d.label, d.date])) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
      await waitFor(() =>
        expect(fetcher.mock.calls.at(-1)?.[0]).toContain(`from=${date}&to=${date}`),
      )
    }
    for (const [label, date] of [
      ['Aujourd’hui', parisDay(new Date())],
      ['Hier', shiftDay(parisDay(new Date()), -1)],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() =>
        expect(fetcher.mock.calls.at(-1)?.[0]).toContain(`from=${date}&to=${date}`),
      )
    }
    fireEvent.click(screen.getByRole('button', { name: 'Toute la période' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Paiement' }), {
      target: { value: 'card' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Analyse des ventes' }))
    await screen.findByRole('table', { name: 'Statistiques produits' })
    expect(screen.getByRole('combobox', { name: 'Paiement' })).toHaveValue('card')
    fireEvent.click(screen.getByRole('button', { name: 'Suivi des caisses' }))
    await screen.findByText('Historique des commandes')
    expect(
      fetcher.mock.calls.every(
        ([url]) => !url.includes('organizationId') && !url.includes('festivalId'),
      ),
    ).toBe(true)
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/config')).toHaveLength(1)
    expect(fetcher.mock.calls.some(([url]) => url.includes('/api/scopes'))).toBe(false)
  })
  it('ignores an obsolete response after changing day and resets independent pages', async () => {
    let resolveOld: (value: Response) => void = () => undefined
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve
    })
    let first = true
    const fetcher = fetchMock((p) => {
      if (first) {
        first = false
        return old
      }
      return response(fixture(p, 10))
    })
    render(<App />)
    const friday = await screen.findByRole('button', { name: /Vendredi/ })
    fireEvent.click(friday)
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    await act(async () => resolveOld(response(fixture(new URLSearchParams(), 99))))
    expect(
      within(screen.getByRole('region', { name: 'Chiffres de la sélection' })).getByText('10'),
    ).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Chiffres de la sélection' })).queryByText('99'),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Suivi des caisses' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commandes : suivant' }))
    await waitFor(() => expect(fetcher.mock.calls.at(-1)?.[0]).toContain('page=2'))
    fireEvent.click(screen.getByRole('button', { name: /Samedi/ }))
    await waitFor(() => expect(fetcher.mock.calls.at(-1)?.[0]).toContain('page=1&correctionPage=1'))
  })
  it('keeps previous successful figures with an explicit error on refresh, but hides them for a failed new filter', async () => {
    let fail = false
    fetchMock((p) =>
      fail ? response({ message: 'Lecture indisponible.' }, false) : response(fixture(p)),
    )
    render(<App />)
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les données' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('dernière lecture réussie')
    expect(screen.getByRole('region', { name: 'Chiffres de la sélection' })).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: 'Tablette' }), {
      target: { value: 'tablet-a' },
    })
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Chiffres de la sélection' })).toBeNull(),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Lecture indisponible')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les données' }))
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('applies inclusive custom dates and opens order details', async () => {
    const fetcher = fetchMock()
    render(<App />)
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    fireEvent.change(screen.getByLabelText('Du', { exact: true }), {
      target: { value: '2026-10-24' },
    })
    fireEvent.change(screen.getByLabelText('Au', { exact: true }), {
      target: { value: '2026-10-25' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Appliquer les dates' }))
    await waitFor(() =>
      expect(fetcher.mock.calls.at(-1)?.[0]).toContain('from=2026-10-24&to=2026-10-25'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Suivi des caisses' }))
    const details = (await screen.findByText('A-0001')).closest('details')!
    fireEvent.click(details.querySelector('summary')!)
    expect(within(details).getByText('2 × Produit test')).toBeVisible()
    expect(within(details).getByText('Option test')).toBeVisible()
  })
  it('refreshes automatically, suspends hidden tabs and resumes without concurrent requests', async () => {
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const fetcher = fetchMock()
    render(<App />)
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('combobox', { name: 'Actualisation' }), {
      target: { value: '30' },
    })
    const before = fetcher.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    expect(fetcher.mock.calls.length).toBe(before + 1)
    hidden = true
    await act(async () => {
      vi.advanceTimersByTime(60000)
    })
    expect(fetcher.mock.calls.length).toBe(before + 1)
    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetcher.mock.calls.length).toBe(before + 2)
  })
  it('shows configuration errors without fabricated zero totals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Configuration indisponible.')))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration indisponible.')
    expect(screen.queryByText('Commandes payées')).toBeNull()
  })
})
