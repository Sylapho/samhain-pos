import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CashSession } from '../../types/salesLedger'
import { CashFloatDialog } from './CashFloatDialog'

const session: CashSession = {
  id: 'session-1',
  terminal: { terminalId: 'terminal-a', terminalCode: 'A', displayName: 'Caisse A' },
  periodStart: '2026-09-01T09:00:00.000Z',
  createdAt: '2026-09-01T09:00:00.000Z',
  openingFloatCents: 0,
}

describe('saisie tactile du fond de caisse', () => {
  it('accepte explicitement 0 € et demande confirmation', async () => {
    const onSubmit = vi.fn(async (amountCents: number) => ({
      ...session,
      openingFloatCents: amountCents,
    }))
    render(<CashFloatDialog mode="opening" onSubmit={onSubmit} />)

    expect(screen.getByRole('button', { name: 'Valider le fond de caisse' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '0' }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider le fond de caisse' }))
    expect(
      screen.getByRole('alertdialog', { name: /Confirmer le fond de caisse de 0,00/ }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(0))
  })

  it('saisit les euros et centimes sans clavier Android', async () => {
    const onSubmit = vi.fn(async (amountCents: number) => ({
      ...session,
      openingFloatCents: amountCents,
    }))
    render(<CashFloatDialog mode="opening" onSubmit={onSubmit} />)

    for (const digit of ['1', '5', '0', '2', '5']) {
      fireEvent.click(screen.getByRole('button', { name: digit }))
    }
    expect(screen.getByLabelText('Montant du fond de caisse')).toHaveTextContent('150,25')
    fireEvent.click(screen.getByRole('button', { name: 'Valider le fond de caisse' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(15_025))
  })

  it('affiche la valeur actuelle avant une modification volontaire', () => {
    render(
      <CashFloatDialog
        mode="editing"
        currentAmountCents={15_000}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText(/Montant actuel/)).toHaveTextContent('150,00')
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument()
  })
})
