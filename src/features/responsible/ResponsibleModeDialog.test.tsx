import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocalStorageResponsibleCredentialRepository,
  ResponsibleModeService,
} from '../../services/responsibleModeService'
import { ResponsibleModeDialog } from './ResponsibleModeDialog'

describe('dialogue du mode responsable', () => {
  beforeEach(() => localStorage.clear())

  it('crée le PIN avec confirmation puis déverrouille la session', async () => {
    const service = createService()
    const onUnlocked = vi.fn()
    render(<ResponsibleModeDialog responsibleMode={service} requireSetup onUnlocked={onUnlocked} />)

    expect(
      screen.getByRole('dialog', { name: 'Configurer le mode responsable' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Annuler' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Nouveau PIN')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Nouveau PIN')).toHaveAttribute('inputmode', 'numeric')

    fireEvent.change(screen.getByLabelText('Nouveau PIN'), { target: { value: '4826' } })
    fireEvent.change(screen.getByLabelText('Confirmer le PIN'), { target: { value: '4827' } })
    fireEvent.click(screen.getByRole('button', { name: 'Créer le PIN' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/ne correspondent pas/)
    expect(onUnlocked).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Nouveau PIN'), { target: { value: '4826' } })
    fireEvent.change(screen.getByLabelText('Confirmer le PIN'), { target: { value: '4826' } })
    fireEvent.click(screen.getByRole('button', { name: 'Créer le PIN' }))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce())
    expect(service.isUnlocked()).toBe(true)
  })

  it('vide le champ après un PIN incorrect', async () => {
    const service = createService()
    await service.setupPin('4826', '4826')
    service.lock()
    render(<ResponsibleModeDialog responsibleMode={service} onUnlocked={vi.fn()} />)

    const input = screen.getByLabelText('PIN responsable')
    fireEvent.change(input, { target: { value: '4827' } })
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('PIN incorrect.')
    expect(input).toHaveValue('')
    expect(service.isUnlocked()).toBe(false)
  })
})

function createService() {
  return new ResponsibleModeService(new LocalStorageResponsibleCredentialRepository(localStorage))
}
