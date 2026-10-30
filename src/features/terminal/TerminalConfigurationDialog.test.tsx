import { act, fireEvent, render, screen } from '@testing-library/react'
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
  it('verrouille une vérification asynchrone puis permet de reprendre après refus', async () => {
    let rejectProof: (error: Error) => void = () => {}
    const proof = new Promise<TerminalConfiguration>((_, reject) => {
      rejectProof = reject
    })
    const onReprovision = vi.fn().mockReturnValue(proof)
    const onConfigured = vi.fn()
    render(
      <TerminalConfigurationDialog
        configuration={configuration}
        onProvision={vi.fn()}
        onRename={vi.fn()}
        onReprovision={onReprovision}
        onConfigured={onConfigured}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Changer la caisse utilisée' }))
    fireEvent.click(screen.getByRole('button', { name: 'W' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer le changement' }))
    expect(screen.getByRole('button', { name: 'Confirmer le changement' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled()
    expect(onConfigured).not.toHaveBeenCalled()
    await act(async () => {
      rejectProof(new Error('Des événements sont en attente.'))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Des événements sont en attente.')
    expect(screen.getByRole('button', { name: 'Confirmer le changement' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeEnabled()
  })
  it('indique au responsable que la synchronisation est absente sans désactiver les paramètres locaux', () => {
    render(
      <TerminalConfigurationDialog
        configuration={configuration}
        onProvision={vi.fn()}
        onRename={vi.fn()}
        onReprovision={vi.fn()}
        onConfigured={vi.fn()}
      />,
    )
    expect(screen.getByText('Synchronisation non configurée')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Enregistrer le nom' })).toBeEnabled()
  })
  it('propose uniquement W au premier provisioning', () => {
    const witchesConfiguration = { ...configuration, terminalCode: 'W' as const, displayName: 'Caisse W' }
    const onProvision = vi.fn().mockReturnValue(witchesConfiguration)
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

    expect(screen.getByRole('button', { name: 'Configurer la tablette' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'W' })).toBeInTheDocument()
    for (const code of ['A', 'B', 'C', 'D']) expect(screen.queryByRole('button', { name: code })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Nom visible')).toHaveValue('Caisse W')
    fireEvent.click(screen.getByRole('button', { name: 'Configurer la tablette' }))

    expect(onProvision).toHaveBeenCalledWith({ terminalCode: 'W', displayName: 'Caisse W' })
    expect(onConfigured).toHaveBeenCalledWith(witchesConfiguration)
  })

  it('sépare le renommage du reprovisionnement explicite', () => {
    const renamed = { ...configuration, displayName: 'Caisse accueil' }
    const reprovisioned = {
      ...configuration,
      terminalId: 'terminal-w',
      terminalCode: 'W' as const,
      displayName: 'Caisse W',
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
    fireEvent.click(screen.getByRole('button', { name: 'W' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))

    expect(onReprovision).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', { name: 'Changer cette tablette de Caisse A vers Caisse W ?' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(onReprovision).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    const confirm = screen.getByRole('button', { name: 'Confirmer le changement' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(onReprovision).toHaveBeenCalledWith({ terminalCode: 'W', displayName: 'Caisse W' })
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
