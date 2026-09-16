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

    expect(screen.getByRole('button', { name: 'Choisir où enregistrer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’intégrité' }))

    expect(await screen.findByText('Valide et complet')).toBeInTheDocument()
    expect(screen.getByText('head-hash')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choisir où enregistrer' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Choisir où enregistrer' }))
    expect(await screen.findByText('Sauvegarde vérifiée')).toBeInTheDocument()
    expect(screen.getByText('archive-hash')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’intégrité' }))
    await screen.findByText('Valide et complet')
    fireEvent.click(screen.getByRole('button', { name: 'Choisir où enregistrer' }))

    expect(screen.getByRole('button', { name: 'Écriture et vérification…' })).toBeDisabled()
    expect(screen.queryByText('Sauvegarde vérifiée')).not.toBeInTheDocument()
    rejectExport?.(new Error('Le fichier écrit n’a pas pu être relu.'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/n’a pas pu être relu/)
    expect(screen.queryByText('Sauvegarde vérifiée')).not.toBeInTheDocument()
  })

  it('présente les corrections et confirme une clôture avec les totaux officiels', async () => {
    const deps = dependencies()
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’intégrité' }))
    await screen.findByText('Valide et complet')
    fireEvent.click(screen.getByRole('tab', { name: 'Clôture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Prévisualiser les totaux' }))

    expect(await screen.findByText('Prévisualisation')).toBeInTheDocument()
    expect(screen.getByText('Montant corrections').nextElementSibling).toHaveTextContent('-2,50')
    expect(screen.getByText('Carte bancaire').nextElementSibling).toHaveTextContent('7,50')
    expect(screen.getByText('Espèces').nextElementSibling).toHaveTextContent('10,00')
    expect(screen.getByText(/Ventilation TVA indisponible/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la clôture' }))
    const closeButton = screen.getByRole('button', { name: 'Clôturer la période' })
    fireEvent.click(closeButton)
    fireEvent.click(closeButton)

    expect(await screen.findByText('Clôture enregistrée')).toBeInTheDocument()
    expect(screen.getByText(/Totaux officiels de l’entrée closure:operation/)).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’intégrité' }))

    expect(await screen.findByText('Invalide')).toBeInTheDocument()
    expect(screen.getByText('Chaînage invalide.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choisir où enregistrer' })).toBeDisabled()
  })

  it('affiche une annulation comme telle, jamais comme un succès', async () => {
    const deps = dependencies()
    deps.backupService.saveVerifiedBackup = vi.fn(async () => ({ status: 'cancelled' }))
    render(<LedgerManagement onClose={vi.fn()} {...deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier l’intégrité' }))
    await screen.findByText('Valide et complet')
    fireEvent.click(screen.getByRole('button', { name: 'Choisir où enregistrer' }))

    expect(
      await screen.findByText('Enregistrement annulé. Aucun fichier n’est déclaré sauvegardé.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Sauvegarde vérifiée')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choisir où enregistrer' })).toBeEnabled(),
    )
  })
})
