import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabletSynchronizationSettings } from './TabletSynchronizationSettings'
import { TabletEnrollmentService } from '../../services/tabletEnrollmentService'
import type { NativeTabletAuth } from '../../native/tabletAuth'

describe('paramètres de synchronisation responsable', () => {
  it('retrouve la connexion native après fermeture de l’écran pendant le navigateur', async () => {
    let authenticated = false
    let finishLogin: (() => void) | undefined
    const bridge: NativeTabletAuth = {
      getStatus: vi.fn(async () => ({
        status: 'pending' as const,
        requestId: 'request',
        installationId: 'installation',
        chainId: 'chain',
      })),
      requestEnrollment: vi.fn(),
      activate: vi.fn(),
      prepareReplacement: vi.fn(),
      inspectEnrollment: vi.fn(),
      managerOperation: vi.fn(),
      managerLogout: vi.fn(),
      managerStatus: vi.fn(async () => ({ authenticated })),
      managerLogin: vi.fn(
        () =>
          new Promise<{ status: 'authenticated' }>((resolve) => {
            finishLogin = () => {
              authenticated = true
              resolve({ status: 'authenticated' })
            }
          }),
      ),
    }
    const service = new TabletEnrollmentService(bridge, true, () => {})
    const first = render(<TabletSynchronizationSettings terminalId="terminal" service={service} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approbation par un responsable serveur' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter au compte responsable' }))
    first.unmount()
    await act(async () => {
      finishLogin?.()
    })

    render(<TabletSynchronizationSettings terminalId="terminal" service={service} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approbation par un responsable serveur' }),
    )
    expect(await screen.findByRole('button', { name: 'Déconnecter le responsable' })).toBeVisible()
    fireEvent.change(screen.getByLabelText('Organisation (identifiant confirmé)'), {
      target: { value: 'org' },
    })
    fireEvent.change(screen.getByLabelText('Festival (identifiant confirmé)'), {
      target: { value: 'festival' },
    })
    expect(screen.getByRole('button', { name: 'Examiner le dossier serveur' })).toBeEnabled()
    expect(bridge.managerLogin).toHaveBeenCalledTimes(1)
    expect(bridge.managerOperation).not.toHaveBeenCalled()
  })
  it('passe par le navigateur responsable et exige l’examen du dossier avant approbation', async () => {
    const bridge: NativeTabletAuth = {
      getStatus: vi.fn(async () => ({
        status: 'pending' as const,
        requestId: 'request',
        installationId: 'installation',
        chainId: 'chain',
      })),
      requestEnrollment: vi.fn(),
      activate: vi.fn(),
      prepareReplacement: vi.fn(),
      managerLogin: vi.fn(async () => ({ status: 'authenticated' as const })),
      managerStatus: vi.fn(async () => ({ authenticated: false })),
      managerLogout: vi.fn(),
      managerOperation: vi.fn(async () => ({ status: 'authorized' as const })),
      inspectEnrollment: vi.fn(async () => ({
        requestId: 'request',
        installationId: 'installation',
        chainId: 'chain',
        terminalId: 'Caisse A',
        restored: false,
        prefixCount: 12,
        legacyCount: 3,
      })),
    }
    render(
      <TabletSynchronizationSettings
        terminalId="terminal"
        service={new TabletEnrollmentService(bridge, true, () => {})}
      />,
    )
    await screen.findByText(/en attente d’approbation/)
    fireEvent.click(screen.getByRole('button', { name: 'Approbation par un responsable serveur' }))
    expect(screen.queryByLabelText('Mot de passe')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Autoriser côté serveur' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter au compte responsable' }))
    await waitFor(() => expect(bridge.managerLogin).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText('Organisation (identifiant confirmé)'), {
      target: { value: 'org' },
    })
    fireEvent.change(screen.getByLabelText('Festival (identifiant confirmé)'), {
      target: { value: 'festival' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Examiner le dossier serveur' }))
    await screen.findByText(/12 événements et 3 commandes historiques/)
    fireEvent.click(screen.getByRole('button', { name: 'Autoriser côté serveur' }))
    await waitFor(() => expect(bridge.managerOperation).toHaveBeenCalledOnce())
    expect(bridge.managerOperation).toHaveBeenCalledWith({
      action: 'approve',
      body: {
        requestId: 'request',
        chainId: 'chain',
        organizationId: 'org',
        festivalId: 'festival',
        replacesInstallationId: undefined,
      },
    })
    expect(bridge.activate).not.toHaveBeenCalled()
  })
  it('distingue autorisation locale, autorisation serveur et révocation sans afficher de token', async () => {
    const bridge: NativeTabletAuth = {
      getStatus: vi.fn(async ({ verify }) => ({
        status: verify ? ('revoked' as const) : ('authorized' as const),
        installationId: 'installation',
        chainId: 'chain',
      })),
      requestEnrollment: vi.fn(),
      activate: vi.fn(),
      inspectEnrollment: vi.fn(),
      managerLogin: vi.fn(async () => ({ status: 'authenticated' as const })),
      managerStatus: vi.fn(async () => ({ authenticated: false })),
      managerLogout: vi.fn(async () => {}),
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
      inspectEnrollment: vi.fn(),
      managerLogin: vi.fn(async () => ({ status: 'authenticated' as const })),
      managerStatus: vi.fn(async () => ({ authenticated: false })),
      managerLogout: vi.fn(async () => {}),
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
    expect(action).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Organisation — Identifiant UUID'), {
      target: { value: 'invalide' },
    })
    expect(
      screen.getByText('L’identifiant de l’organisation doit être un UUID valide.'),
    ).toBeVisible()
    fireEvent.change(screen.getByLabelText('Organisation — Identifiant UUID'), {
      target: { value: ' a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3 ' },
    })
    expect(action).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Festival — Identifiant UUID'), {
      target: { value: '18bdec64-385a-4f86-958f-184a81635c96' },
    })
    fireEvent.click(action)
    fireEvent.click(action)
    expect(bridge.requestEnrollment).toHaveBeenCalledTimes(1)
    expect(bridge.requestEnrollment).toHaveBeenCalledWith({
      terminalId: 'terminal',
      organizationId: 'a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3',
      festivalId: '18bdec64-385a-4f86-958f-184a81635c96',
      reconnect: false,
    })
    finish?.({ status: 'pending', requestId: 'request' })
    await waitFor(() => expect(screen.getByText(/en attente d’approbation/)).toBeVisible())
  })
  it('restaure le périmètre natif et le confirme sans nouvelle saisie', async () => {
    const requestedScope = {
      organizationId: 'a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3',
      festivalId: '18bdec64-385a-4f86-958f-184a81635c96',
    }
    const native = {
      getStatus: vi.fn(async () => ({
        status: 'pending' as const,
        requestId: 'request',
        chainId: 'chain',
        requestedScope,
        enrollmentPrepared: true,
      })),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
    } as unknown as NativeTabletAuth
    render(
      <TabletSynchronizationSettings
        terminalId="terminal"
        service={new TabletEnrollmentService(native, true, () => {})}
      />,
    )
    await screen.findByText(/Périmètre demandé/)
    expect(screen.getByLabelText('Organisation — Identifiant UUID')).toHaveValue(
      requestedScope.organizationId,
    )
    expect(screen.getByLabelText('Festival — Identifiant UUID')).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'Approbation par un responsable serveur' }))
    expect(screen.getByLabelText('Organisation (identifiant confirmé)')).toHaveValue(
      requestedScope.organizationId,
    )
    expect(screen.getByLabelText('Festival (identifiant confirmé)')).toHaveValue(
      requestedScope.festivalId,
    )
    expect(screen.getByLabelText('Organisation (identifiant confirmé)')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Autoriser côté serveur' })).toBeDisabled()
  })
})
