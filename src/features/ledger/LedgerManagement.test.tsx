import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { VerifiedBackupResult } from '../../services/salesBackupService'
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

const preview: ClosurePreview = {
  periodStart: '2026-09-16T00:00:00.000Z',
  periodEnd: '2026-09-16T19:00:00.000Z',
  terminal: { terminalId: 'terminal-a', terminalCode: 'A', displayName: 'Caisse A' },
  totals,
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
  },
} as ClosureLedgerEntry

const backup = {
  status: 'verified',
  fileName: 'samhain-pos-backup-caisse-A.json',
  destination: 'content://document/backup',
  bytesWritten: 123,
  verification: integrity,
  archive: {
    archiveId: 'archive-id',
    archiveHash: 'archive-hash',
    exportedAt: '2026-09-16T19:45:00.000Z',
    source: { terminal: preview.terminal },
    entries: [{ kind: 'sale' }, { kind: 'sale' }],
  },
} as VerifiedBackupResult

function dependencies() {
  return {
    ledgerService: {
      verifyIntegrity: vi.fn(async () => integrity),
      previewClosure: vi.fn(async () => preview),
      closePeriod: vi.fn(async () => closure),
      getLastClosureEnd: vi.fn(async () => null),
    },
    backupService: {
      saveVerifiedBackup: vi.fn(async () => backup),
    },
  }
}

describe('LedgerManagement', () => {
  it('affiche le résultat réel de la vérification et permet une sauvegarde sans clôture', async () => {
    const deps = dependencies()
    render(
      <LedgerManagement
        onClose={vi.fn()}
        {...deps}
        now={() => new Date('2026-09-16T19:45:00.000Z')}
      />,
    )

    expect(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))

    expect(await screen.findByText('Ventes vérifiées')).toBeInTheDocument()
    expect(screen.queryByText('head-hash')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' }))
    expect(await screen.findByText('Sauvegarde enregistrée')).toBeInTheDocument()
    expect(screen.queryByText('archive-hash')).not.toBeInTheDocument()
    expect(deps.backupService.saveVerifiedBackup).toHaveBeenCalledOnce()
    expect(deps.ledgerService.closePeriod).not.toHaveBeenCalled()
  })

  it('n’affiche jamais le succès pendant l’écriture et affiche l’erreur d’export', async () => {
    const deps = dependencies()
    let rejectExport: ((error: Error) => void) | undefined
    deps.backupService.saveVerifiedBackup = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectExport = reject
        }),
    )
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))
    await screen.findByText('Ventes vérifiées')
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' }))

    expect(screen.getByRole('button', { name: 'Enregistrement…' })).toBeDisabled()
    expect(screen.queryByText('Sauvegarde enregistrée')).not.toBeInTheDocument()
    rejectExport?.(new Error('Le fichier écrit n’a pas pu être relu.'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /sauvegarde n’a pas pu être enregistrée/,
    )
    expect(screen.queryByText('Sauvegarde enregistrée')).not.toBeInTheDocument()
  })

  it('présente les corrections et confirme une clôture avec les totaux officiels', async () => {
    const deps = dependencies()
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))
    await screen.findByText('Ventes vérifiées')
    fireEvent.click(screen.getByRole('tab', { name: 'Clôture de caisse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Afficher les totaux' }))

    expect(await screen.findByText('Totaux de la période')).toBeInTheDocument()
    expect(screen.getByText('Montant des corrections').nextElementSibling).toHaveTextContent(
      '-2,50',
    )
    expect(screen.getByText('Carte bancaire').nextElementSibling).toHaveTextContent('7,50')
    expect(screen.getByText('Espèces').nextElementSibling).toHaveTextContent('10,00')
    expect(screen.getByText(/Ventilation TVA indisponible/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    const closeButton = screen.getByRole('button', { name: 'Clôturer la caisse' })
    fireEvent.click(closeButton)
    fireEvent.click(closeButton)

    expect(await screen.findByText('Clôture enregistrée')).toBeInTheDocument()
    expect(screen.getByText('Totaux enregistrés')).toBeInTheDocument()
    expect(deps.ledgerService.closePeriod).toHaveBeenCalledOnce()
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
    expect(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' })).toBeDisabled()
  })

  it('affiche une annulation comme telle, jamais comme un succès', async () => {
    const deps = dependencies()
    deps.backupService.saveVerifiedBackup = vi.fn(async () => ({ status: 'cancelled' }))
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier les ventes' }))
    await screen.findByText('Ventes vérifiées')
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' }))

    expect(
      await screen.findByText('Enregistrement annulé. Aucune sauvegarde n’a été créée.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Sauvegarde enregistrée')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enregistrer une sauvegarde' })).toBeEnabled(),
    )
  })
})
