import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'
import type { Report } from '../../server/src/dashboard/types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  festivalId: '22222222-2222-4222-8222-222222222222',
  active: true,
}
function fixture(): Report {
  const totals = { count: 1, gross: 202, corrections: 0, net: 202 }
  return {
    generatedAt: '2026-10-25T12:00:00Z',
    totals: { ...totals, average: 202, correctionCount: 0, legacyCount: 0 },
    tablets: [{ id: 'tablet-a', name: 'Tablette A', lastReceivedAt: null, totals }],
    payments: [{ name: 'cash', totals }],
    days: [],
    products: [],
    corrections: [],
    sales: [
      {
        id: 'sale-1',
        number: 'A-0001',
        receipt: 'RECU-1',
        terminalId: 'tablet-a',
        tablet: 'Tablette A',
        at: '2026-10-25T12:00:00Z',
        receivedAt: null,
        method: 'cash',
        cents: 202,
        legacy: true,
        lines: [
          { name: 'Produit test', quantity: 2, unitPriceCents: 101, details: ['Option test'] },
        ],
      },
    ],
    page: 1,
    pageCount: 1,
    saleCount: 1,
  }
}
describe('dashboard consultation', () => {
  it('applies tablet filters and removes old figures if the filtered request fails, then recovers', async () => {
    let fail = false
    const fetcher = vi.fn(async (input: string) => {
      if (input === '/api/scopes') return Response.json([scope])
      return fail
        ? Response.json({ message: 'Lecture indisponible.' }, { status: 503 })
        : Response.json(fixture())
    })
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    const metrics = await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    expect(within(metrics).getByText('Ventes enregistrées')).toBeVisible()
    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'Voir les ventes de Tablette A' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Lecture indisponible.')
    expect(screen.queryByRole('region', { name: 'Chiffres de la sélection' })).toBeNull()
    expect(screen.getByLabelText('Tablette')).toHaveValue('tablet-a')
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain('terminal=tablet-a')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser les données' }))
    await screen.findByRole('region', { name: 'Chiffres de la sélection' })
    expect(screen.queryByRole('alert')).toBeNull()
    const details = screen.getByText('A-0001').closest('details')!
    fireEvent.click(details.querySelector('summary')!)
    await waitFor(() => expect(details).toHaveAttribute('open'))
    expect(within(details).getByText('2 × Produit test')).toBeVisible()
    expect(within(details).getByText('Option test')).toBeVisible()
  })
  it('shows connection failures without displaying a zero sales total', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connexion interrompue.')))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion interrompue.')
    expect(screen.queryByText('Ventes enregistrées')).toBeNull()
    expect(screen.getByRole('button', { name: 'Actualiser les données' })).toBeEnabled()
  })
})
