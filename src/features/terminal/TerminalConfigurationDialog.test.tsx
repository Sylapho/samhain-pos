import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalConfiguration } from '../../types/terminal'
import { TerminalConfigurationDialog } from './TerminalConfigurationDialog'

const configuration: TerminalConfiguration = {
  terminalId: 'terminal-a',
  terminalCode: 'A',
  displayName: 'Caisse A',
  provisionedAt: '2026-09-01T10:00:00.000Z',
}

describe('configuration de la caisse', () => {
  it('impose un code A à D au premier provisioning et propose le nom correspondant', () => {
    const onProvision = vi.fn().mockReturnValue(configuration)
    const onConfigured = vi.fn()

    render(
      <TerminalConfigurationDialog
        configuration={null}
        onProvision={onProvision}
        onRename={vi.fn()}
        onReprovision={vi.fn()}
        onConfigured={onConfigured}
      />,
    )

    expect(screen.getByRole('button', { name: 'Configurer la tablette' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(screen.getByLabelText('Nom visible')).toHaveValue('Caisse A')
    fireEvent.click(screen.getByRole('button', { name: 'Configurer la tablette' }))

    expect(onProvision).toHaveBeenCalledWith({ terminalCode: 'A', displayName: 'Caisse A' })
    expect(onConfigured).toHaveBeenCalledWith(configuration)
  })

  it('sépare le renommage du reprovisionnement explicite', () => {
    const renamed = { ...configuration, displayName: 'Caisse accueil' }
    const reprovisioned = {
      ...configuration,
      terminalId: 'terminal-b',
      terminalCode: 'B' as const,
      displayName: 'Caisse B',
    }
    const onRename = vi.fn().mockReturnValue(renamed)
    const onReprovision = vi.fn().mockReturnValue(reprovisioned)
    const onConfigured = vi.fn()

    const { rerender } = render(
      <TerminalConfigurationDialog
        configuration={configuration}
        onProvision={vi.fn()}
        onRename={onRename}
        onReprovision={onReprovision}
        onConfigured={onConfigured}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Nom visible'), {
      target: { value: 'Caisse accueil' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer le nom' }))
    expect(onRename).toHaveBeenCalledWith('Caisse accueil')
    expect(onReprovision).not.toHaveBeenCalled()

    rerender(
      <TerminalConfigurationDialog
        configuration={configuration}
        onProvision={vi.fn()}
        onRename={onRename}
        onReprovision={onReprovision}
        onConfigured={onConfigured}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Changer la caisse utilisée' }))
    expect(screen.getByText(/nouvelles commandes seront rattachées/)).toBeInTheDocument()
    expect(screen.getByText('Nom : Caisse A')).toBeInTheDocument()
    expect(screen.getByText('Code : A')).toBeInTheDocument()
    expect(screen.queryByText(/terminal-a/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))

    expect(onReprovision).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', { name: 'Changer cette tablette de Caisse A vers Caisse B ?' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(onReprovision).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    const confirm = screen.getByRole('button', { name: 'Confirmer le changement' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(onReprovision).toHaveBeenCalledWith({ terminalCode: 'B', displayName: 'Caisse B' })
    expect(onReprovision).toHaveBeenCalledTimes(1)
  })

  it('bloque le reprovisionnement lorsqu’une impression doit être reprise', () => {
    render(
      <TerminalConfigurationDialog
        configuration={configuration}
        onProvision={vi.fn()}
        onRename={vi.fn()}
        onReprovision={vi.fn()}
        onConfigured={vi.fn()}
        reprovisioningBlockReason="Impossible de reprovisionner cette caisse tant que des impressions sont à reprendre ou à vérifier."
      />,
    )

    expect(screen.getByRole('button', { name: 'Changer la caisse utilisée' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/impressions sont à reprendre/)
  })
})
