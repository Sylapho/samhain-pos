import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabletSynchronizationSettings } from './TabletSynchronizationSettings'
import { TabletEnrollmentService } from '../../services/tabletEnrollmentService'
import type { NativeTabletAuth } from '../../native/tabletAuth'

describe('paramètres de synchronisation responsable', () => {
  it('distingue autorisation locale, autorisation serveur et révocation sans afficher de token', async () => {
    const bridge: NativeTabletAuth = {
      getStatus: vi.fn(async ({ verify }) => ({
        status: verify ? ('revoked' as const) : ('authorized' as const),
        installationId: 'installation',
        chainId: 'chain',
      })),
      requestEnrollment: vi.fn(),
      activate: vi.fn(),
      managerOperation: vi.fn(),
      prepareReplacement: vi.fn(),
    }
    render(
      <TabletSynchronizationSettings
        terminalId="terminal"
        service={new TabletEnrollmentService(bridge, true, () => {})}
      />,
    )
    expect(await screen.findByText('Tablette autorisée pour la synchronisation')).toBeVisible()
    expect(screen.getByText(/Dernier état enregistré/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier / rafraîchir la session' }))
    expect(await screen.findByText(/Tablette révoquée/)).toBeVisible()
    expect(screen.getByText(/Les ventes et impressions fonctionnent sans connexion/)).toBeVisible()
    expect(screen.queryByText(/access_token|refresh_token/)).not.toBeInTheDocument()
  })
  it('empêche deux demandes avec des taps répétés', async () => {
    let finish: ((value: { status: 'pending'; requestId: string }) => void) | undefined
    const bridge: NativeTabletAuth = {
      getStatus: vi.fn(async () => ({ status: 'not_enrolled' as const })),
      requestEnrollment: vi.fn(
        () =>
          new Promise<{ status: 'pending'; requestId: string }>((resolve) => {
            finish = resolve
          }),
      ),
      activate: vi.fn(),
      managerOperation: vi.fn(),
      prepareReplacement: vi.fn(),
    }
    render(
      <TabletSynchronizationSettings
        terminalId="terminal"
        service={new TabletEnrollmentService(bridge, true, () => {})}
      />,
    )
    await screen.findByText('Tablette non enrôlée')
    const action = screen.getByRole('button', { name: 'Demander l’enrôlement / reconnecter' })
    fireEvent.click(action)
    fireEvent.click(action)
    expect(bridge.requestEnrollment).toHaveBeenCalledTimes(1)
    finish?.({ status: 'pending', requestId: 'request' })
    await waitFor(() => expect(screen.getByText(/en attente d’approbation/)).toBeVisible())
  })
})
