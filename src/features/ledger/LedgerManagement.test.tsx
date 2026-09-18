import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ClosureLedgerEntry,
  ClosurePreview,
  IntegrityVerification,
} from '../../types/salesLedger'
import { LedgerManagement } from './LedgerManagement'

const integrity: IntegrityVerification = {
  valid: true,
  complete: true,
  entryCount: 4,
  sealedOrderCount: 2,
  legacyOrderIds: [],
  errors: [],
  warnings: [],
  headHash: 'head-hash',
}

const totals = {
  saleCount: 2,
  grossSalesCents: 2_000,
  correctionCount: 1,
  correctionTotalCents: -250,
  netTotalCents: 1_750,
  cumulativeNetTotalCents: 1_750,
  paymentTotalsCents: { card: 750, cash: 1_000 },
}

const cashSession = {
  id: 'session-1',
  terminal: { terminalId: 'terminal-a', terminalCode: 'A' as const, displayName: 'Caisse A' },
  periodStart: '2026-09-16T00:00:00.000Z',
  createdAt: '2026-09-16T00:00:00.000Z',
  openingFloatCents: 15_000,
}

const preview: ClosurePreview = {
  periodStart: '2026-09-16T00:00:00.000Z',
  periodEnd: '2026-09-16T19:00:00.000Z',
  terminal: { terminalId: 'terminal-a', terminalCode: 'A', displayName: 'Caisse A' },
  totals,
  cashSession,
  theoreticalCashCents: 16_000,
  integrity,
  vatBreakdown: null,
  vatUnavailableReason:
    'Ventilation TVA indisponible : les corrections ne contiennent pas de ventilation par taux.',
}

const closure = {
  id: 'closure:operation',
  kind: 'closure',
  source: { terminal: preview.terminal },
  closure: {
    operationId: 'operation',
    periodStart: preview.periodStart,
    periodEnd: preview.periodEnd,
    totals,
    cashSessionId: cashSession.id,
    openingFloatCents: cashSession.openingFloatCents,
    theoreticalCashCents: 16_000,
  },
} as ClosureLedgerEntry

function dependencies() {
  return {
    ledgerService: {
      verifyIntegrity: vi.fn(async () => integrity),
      previewClosure: vi.fn(async () => preview),
      closePeriod: vi.fn(async () => closure),
      getLastClosureEnd: vi.fn(async () => null),
    },
    cashSessionService: {
      getActiveSession: vi.fn(async () => cashSession),
      updateOpeningFloat: vi.fn(async (amountCents: number) => ({
        ...cashSession,
        openingFloatCents: amountCents,
      })),
    },
  }
}

describe('LedgerManagement', () => {
  it('affiche uniquement les outils de clôture, sans la partie sauvegarde', async () => {
    const deps = dependencies()
    render(
      <LedgerManagement
        onClose={vi.fn()}
        {...deps}
        now={() => new Date('2026-09-16T19:45:00.000Z')}
      />,
    )

    expect(screen.queryByText('Sauvegarde')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sauvegard/i })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Clôturer la caisse' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))

    expect(await screen.findByText('Ventes vérifiées')).toBeInTheDocument()
    expect(screen.queryByText('head-hash')).not.toBeInTheDocument()
    expect(deps.ledgerService.closePeriod).not.toHaveBeenCalled()
  })

  it('présente les corrections et confirme une clôture avec les totaux officiels', async () => {
    const deps = dependencies()
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))
    await screen.findByText('Ventes vérifiées')
    fireEvent.click(screen.getByRole('button', { name: 'Afficher les totaux' }))

    expect(await screen.findByText('Totaux de la période')).toBeInTheDocument()
    expect(screen.getByText('Montant des corrections').nextElementSibling).toHaveTextContent(
      '-2,50',
    )
    expect(screen.getByText('Carte bancaire').nextElementSibling).toHaveTextContent('7,50')
    expect(
      screen.getAllByText('Fond de caisse initial').at(-1)?.nextElementSibling,
    ).toHaveTextContent('150,00')
    expect(screen.getByText('Encaissements espèces').nextElementSibling).toHaveTextContent('10,00')
    expect(screen.getByText('Total théorique en caisse').nextElementSibling).toHaveTextContent(
      '160,00',
    )
    expect(screen.getByText(/Ventilation TVA indisponible/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    const closeButton = screen.getByRole('button', { name: 'Clôturer la caisse' })
    fireEvent.click(closeButton)
    fireEvent.click(closeButton)

    expect(await screen.findByText('Clôture enregistrée')).toBeInTheDocument()
    expect(screen.getByText('Totaux enregistrés')).toBeInTheDocument()
    expect(deps.ledgerService.closePeriod).toHaveBeenCalledOnce()
  })

  it('conserve l’heure exacte de début de session pour calculer et confirmer la clôture', async () => {
    const deps = dependencies()
    const exactPeriodStart = '2026-09-16T08:17:43.527Z'
    deps.cashSessionService.getActiveSession = vi.fn(async () => ({
      ...cashSession,
      periodStart: exactPeriodStart,
      createdAt: exactPeriodStart,
    }))
    render(
      <LedgerManagement
        onClose={vi.fn()}
        {...deps}
        now={() => new Date('2026-09-16T19:45:30.000Z')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))
    await screen.findByText('Ventes vérifiées')
    const previewButton = screen.getByRole('button', { name: 'Afficher les totaux' })
    await waitFor(() => expect(previewButton).toBeEnabled())
    fireEvent.click(previewButton)

    expect(await screen.findByText('Totaux de la période')).toBeInTheDocument()
    expect(deps.ledgerService.previewClosure).toHaveBeenCalledWith(
      new Date(exactPeriodStart),
      expect.any(Date),
      expect.any(Date),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clôturer la caisse' }))

    await screen.findByText('Clôture enregistrée')
    expect(deps.ledgerService.closePeriod).toHaveBeenCalledWith(
      new Date(exactPeriodStart),
      expect.any(Date),
    )
  })

  it('bloque les actions sûres lorsque le journal est invalide', async () => {
    const deps = dependencies()
    deps.ledgerService.verifyIntegrity = vi.fn(async () => ({
      ...integrity,
      valid: false,
      complete: false,
      errors: ['Chaînage invalide.'],
    }))
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)

    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))

    expect(await screen.findByText('Vérification impossible')).toBeInTheDocument()
    expect(screen.queryByText('Chaînage invalide.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Afficher les totaux' })).toBeDisabled()
  })
})
