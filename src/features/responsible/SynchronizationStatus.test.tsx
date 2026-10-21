import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { SyncDiagnostics } from '../../services/synchronizationService'
import type { ResponsibleMode } from '../../services/responsibleModeService'
import { SynchronizationStatus } from './SynchronizationStatus'

const pendingState: SyncDiagnostics = {
  enabled: true,
  authentication: 'authorized',
  pendingEvents: 5,
  pending: 5,
  sending: 0,
  errors: 0,
  continuity: 'unknown',
  backfillComplete: true,
  lastSuccessAt: null,
  lastServerReceivedAt: null,
  lastExchangeAt: null,
  lastError: null,
  errorCategory: 'none',
}
function setup(state: SyncDiagnostics = pendingState, unlocked = true) {
  const mode: ResponsibleMode = {
    hasCredential: () => true,
    setupPin: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(() => {
      unlocked = false
    }),
    isUnlocked: () => unlocked,
    requireUnlocked: () => {
      if (!unlocked) throw new Error('locked')
    },
  }
  const service = {
    diagnostics: vi.fn(async () => state),
    retry: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
  }
  const onLocked = vi.fn()
  const onConfigure = vi.fn()
  return { mode, service, onLocked, onConfigure }
}
afterEach(() => vi.useRealTimers())

describe('Suivi responsable', () => {
  it('affiche tous les événements et les dates fiables distinctement', async () => {
    const state = setup({
      ...pendingState,
      lastSuccessAt: Date.parse('2026-10-21T14:40:00Z'),
      lastServerReceivedAt: '2026-10-20T12:32:00Z',
    })
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await screen.findByText('5 opérations en attente d’envoi')
    expect(screen.getByText('Opérations non confirmées').nextElementSibling).toHaveTextContent('5')
    expect(
      screen.getByText('Dernière synchronisation confirmée (réception serveur)').nextElementSibling,
    ).toHaveTextContent('20/10/2026')
    expect(
      screen.getByText('Confirmation enregistrée sur la tablette').nextElementSibling,
    ).toHaveTextContent('21/10/2026')
    expect(
      screen.getByText('Dernier échange réel avec le service').nextElementSibling,
    ).toHaveTextContent('Non disponible')
    expect(screen.queryByText('Synchronisation à jour')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actualiser le suivi' })).toHaveFocus()
  })

  it('un double clic ne demande qu’une relance, puis relit les diagnostics sans annoncer un succès', async () => {
    const state = setup()
    let finish!: () => void
    state.service.retry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await screen.findByText('5 opérations en attente d’envoi')
    const retry = screen.getByRole('button', { name: 'Relancer la synchronisation' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(retry).toBeDisabled()
    expect(state.service.retry).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(state.service.diagnostics).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Demande de reprise transmise/)).toBeInTheDocument()
    expect(screen.queryByText('Synchronisation à jour')).not.toBeInTheDocument()
  })

  it.each([
    { ...pendingState, sending: 1, pending: 4 },
    { ...pendingState, errorCategory: 'conflict' as const, errors: 1 },
    { ...pendingState, authentication: 'native_only' },
  ])('interdit la relance pour un envoi actif, un conflit ou le Web', async (diagnostics) => {
    const state = setup(diagnostics)
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await waitFor(() => expect(screen.queryByText('Lecture du suivi…')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Relancer la synchronisation' })).toBeDisabled()
  })

  it('réutilise la configuration existante pour une session expirée', async () => {
    const state = setup({ ...pendingState, authentication: 'session_expired' })
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Paramètres de synchronisation' }))
    expect(state.onConfigure).toHaveBeenCalledOnce()
  })

  it('gère une lecture impossible et masque toute erreur technique', async () => {
    const state = setup()
    state.service.diagnostics.mockRejectedValue(new Error('SQL JWT secret'))
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await screen.findByText('Suivi non disponible')
    expect(screen.queryByText(/SQL|JWT|secret/)).not.toBeInTheDocument()
    expect(screen.getByText('Opérations non confirmées').nextElementSibling).toHaveTextContent(
      'Non disponible',
    )
  })

  it('ne lit aucun diagnostic en mode verrouillé', () => {
    const state = setup(pendingState, false)
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    expect(state.service.diagnostics).not.toHaveBeenCalled()
    expect(screen.queryByText('Opérations non confirmées')).not.toBeInTheDocument()
    expect(state.onLocked).toHaveBeenCalled()
  })

  it('retire les détails à expiration sans prolonger le PIN par les lectures automatiques', async () => {
    vi.useFakeTimers()
    const state = setup()
    function Protected() {
      const [open, setOpen] = useState(true)
      return open ? (
        <SynchronizationStatus
          {...state}
          responsibleMode={state.mode}
          onLocked={() => setOpen(false)}
        />
      ) : (
        <p>Verrouillé</p>
      )
    }
    render(<Protected />)
    await act(async () => {})
    expect(screen.getByText('5 opérations en attente d’envoi')).toBeInTheDocument()
    state.mode.lock()
    await act(async () => vi.advanceTimersByTime(501))
    expect(screen.getByText('Verrouillé')).toBeInTheDocument()
    expect(screen.queryByText('Opérations non confirmées')).not.toBeInTheDocument()
  })

  it('la fermeture arrête uniquement la lecture du suivi et laisse la relance se terminer', async () => {
    const state = setup()
    let finish!: () => void
    state.service.retry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const view = render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await screen.findByText('5 opérations en attente d’envoi')
    fireEvent.click(screen.getByRole('button', { name: 'Relancer la synchronisation' }))
    view.unmount()
    await act(async () => finish())
    expect(state.service.retry).toHaveBeenCalledOnce()
  })

  it('ignore une ancienne lecture qui répond après une actualisation plus récente', async () => {
    const state = setup()
    let finish!: (value: SyncDiagnostics) => void
    state.service.diagnostics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser le suivi' }))
    await screen.findByRole('heading', { name: '5 opérations en attente d’envoi' })
    await act(async () =>
      finish({
        ...pendingState,
        pendingEvents: 0,
        pending: 0,
        continuity: 'verified',
        lastSuccessAt: Date.now(),
        lastServerReceivedAt: '2026-10-21T12:32:00Z',
      }),
    )
    expect(
      screen.getByRole('heading', { name: '5 opérations en attente d’envoi' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Synchronisation à jour')).not.toBeInTheDocument()
  })

  it('réactive les échanges via le service existant sans annoncer de reçu serveur', async () => {
    const state = setup({ ...pendingState, enabled: false })
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Réactiver la synchronisation' }))
    await waitFor(() => expect(state.service.diagnostics).toHaveBeenCalledTimes(2))
    expect(state.service.setEnabled).toHaveBeenCalledWith(true)
    expect(state.service.retry).not.toHaveBeenCalled()
    expect(screen.queryByText('Synchronisation à jour')).not.toBeInTheDocument()
  })

  it('verrouille et ferme le suivi lorsque l’application passe en arrière-plan', async () => {
    const state = setup()
    render(<SynchronizationStatus {...state} responsibleMode={state.mode} />)
    await screen.findByRole('heading', { name: '5 opérations en attente d’envoi' })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      fireEvent(document, new Event('visibilitychange'))
      expect(state.mode.lock).toHaveBeenCalledOnce()
      expect(state.onLocked).toHaveBeenCalledOnce()
    } finally {
      visibility.mockRestore()
    }
  })
})
