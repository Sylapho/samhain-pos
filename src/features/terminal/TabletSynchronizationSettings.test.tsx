import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabletSynchronizationSettings } from './TabletSynchronizationSettings'
import { TabletEnrollmentService } from '../../services/tabletEnrollmentService'
import type { NativeTabletAuth, TabletAuthorization } from '../../native/tabletAuth'

const scope = {
  organizationId: 'a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3',
  festivalId: '18bdec64-385a-4f86-958f-184a81635c96',
}
const pending: TabletAuthorization = {
  status: 'pending',
  requestId: 'request',
  installationId: 'installation',
  chainId: 'chain',
  requestedScope: scope,
  enrollmentPrepared: true,
}
const dossier = {
  requestId: 'request',
  installationId: 'installation',
  chainId: 'chain',
  terminalId: 'Caisse A',
  restored: false,
  prefixCount: 12,
  legacyCount: 3,
}
function bridge(overrides: Partial<NativeTabletAuth> = {}): NativeTabletAuth {
  return {
    getStatus: vi.fn(async () => ({ status: 'not_enrolled' as const })),
    requestEnrollment: vi.fn(async () => pending),
    inspectEnrollment: vi.fn(async () => dossier),
    managerStatus: vi.fn(async () => ({ authenticated: false })),
    managerLogin: vi.fn(async () => ({ status: 'authenticated' as const })),
    managerLogout: vi.fn(async () => {}),
    managerOperation: vi.fn(async () => ({ status: 'authorized' as const })),
    activate: vi.fn(),
    prepareReplacement: vi.fn(),
    ...overrides,
  }
}
function show(native: NativeTabletAuth) {
  const service = new TabletEnrollmentService(native, true, () => {})
  return render(<TabletSynchronizationSettings terminalId="terminal" service={service} />)
}
async function connect() {
  const login = await screen.findByRole('button', { name: 'Se connecter au compte responsable' })
  await waitFor(() => expect(login).toBeEnabled())
  fireEvent.click(login)
  await screen.findByText('Compte responsable connecté')
}
const examine = () => screen.getByRole('button', { name: 'Examiner le dossier serveur' })
const approve = () => screen.getByRole('button', { name: 'Autoriser côté serveur' })

describe('approbation simplifiée de la tablette', () => {
  it('reprend une demande interrompue avant réception de son identifiant', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'server_unreachable',
        installationId: 'installation',
        requestedScope: scope,
        enrollmentPrepared: true,
      })
      .mockResolvedValue(pending)
    const native = bridge({ requestEnrollment: request })
    show(native)
    await connect()
    fireEvent.click(examine())
    await screen.findByRole('alert')
    expect(approve()).toBeDisabled()
    expect(native.inspectEnrollment).not.toHaveBeenCalled()
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls).toEqual([
      [{ terminalId: 'terminal', ...scope, reconnect: false }],
      [{ terminalId: 'terminal', ...scope, reconnect: false }],
    ])
  })
  it('prépare une nouvelle demande explicite après un refus avec le périmètre conservé', async () => {
    const native = bridge({
      getStatus: vi.fn(async () => ({ ...pending, status: 'rejected' as const })),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
    })
    show(native)
    await waitFor(() => expect(examine()).toBeEnabled())
    expect(screen.getByText(/L’examen préparera une nouvelle demande/)).toBeVisible()
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    expect(native.requestEnrollment).toHaveBeenCalledWith({
      terminalId: 'terminal',
      ...scope,
      reconnect: true,
    })
    expect(approve()).toBeEnabled()
    expect(native.managerOperation).not.toHaveBeenCalled()
  })
  it('se connecte, examine puis autorise sans saisie ni demande séparée', async () => {
    const native = bridge()
    show(native)
    await screen.findByText('Tablette non enrôlée')
    expect(examine()).toBeDisabled()
    expect(approve()).toBeDisabled()
    expect(screen.getByLabelText('Organisation — Identifiant UUID')).not.toBeVisible()
    expect(
      screen.queryByLabelText('Chaîne (existante en cas de remplacement)'),
    ).not.toBeInTheDocument()
    await connect()
    expect(native.requestEnrollment).not.toHaveBeenCalled()
    fireEvent.click(examine())
    await screen.findByText(/12 événements et 3 commandes historiques/)
    expect(native.requestEnrollment).toHaveBeenCalledWith({
      terminalId: 'terminal',
      ...scope,
      reconnect: false,
    })
    expect(native.inspectEnrollment).toHaveBeenCalledWith({ requestId: 'request', ...scope })
    expect(native.managerOperation).not.toHaveBeenCalled()
    fireEvent.click(approve())
    await screen.findByText('Tablette autorisée pour la synchronisation')
    expect(native.managerOperation).toHaveBeenCalledWith({
      action: 'approve',
      body: { requestId: 'request', ...scope, chainId: 'chain', replacesInstallationId: undefined },
    })
    expect(native.activate).not.toHaveBeenCalled()
  })
  it('retrouve la session native et le périmètre enregistré après fermeture pendant OIDC', async () => {
    let authenticated = false
    let finishLogin: (() => void) | undefined
    const savedScope = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      festivalId: '22222222-2222-4222-8222-222222222222',
    }
    const native = bridge({
      getStatus: vi.fn(async () => ({ ...pending, requestedScope: savedScope })),
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
    })
    const first = show(native)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Se connecter au compte responsable' }),
      ).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter au compte responsable' }))
    first.unmount()
    await act(async () => {
      finishLogin?.()
    })
    show(native)
    await screen.findByText('Compte responsable connecté')
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    fireEvent.click(approve())
    await waitFor(() => expect(native.managerOperation).toHaveBeenCalledOnce())
    expect(native.managerOperation).toHaveBeenCalledWith({
      action: 'approve',
      body: {
        requestId: 'request',
        ...savedScope,
        chainId: 'chain',
        replacesInstallationId: undefined,
      },
    })
    expect(native.requestEnrollment).not.toHaveBeenCalled()
    expect(native.managerLogin).toHaveBeenCalledOnce()
  })
  it('examine les anciennes demandes sans périmètre avec les identifiants fournis', async () => {
    const native = bridge({
      getStatus: vi.fn(async () => ({ ...pending, requestedScope: undefined })),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
    })
    show(native)
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    expect(native.requestEnrollment).not.toHaveBeenCalled()
    expect(native.inspectEnrollment).toHaveBeenCalledWith({ requestId: 'request', ...scope })
    expect(approve()).toBeEnabled()
  })
  it('récupère automatiquement la chaîne du dossier vérifié', async () => {
    const native = bridge({
      getStatus: vi.fn(async () => ({ ...pending, chainId: undefined })),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
    })
    show(native)
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    fireEvent.click(approve())
    await waitFor(() => expect(native.managerOperation).toHaveBeenCalledOnce())
    expect(native.managerOperation).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ chainId: 'chain' }) }),
    )
  })
  it.each(['installationId', 'chainId', 'requestId'] as const)(
    'refuse un dossier avec un %s étranger',
    async (field) => {
      const native = bridge({
        getStatus: vi.fn(async () => pending),
        managerStatus: vi.fn(async () => ({ authenticated: true })),
        inspectEnrollment: vi.fn(async () => ({ ...dossier, [field]: 'foreign' })),
      })
      show(native)
      await waitFor(() => expect(examine()).toBeEnabled())
      fireEvent.click(examine())
      await screen.findByText(/Le dossier ne correspond pas/)
      expect(approve()).toBeDisabled()
      expect(native.managerOperation).not.toHaveBeenCalled()
    },
  )
  it('conserve une demande créée quand l’examen échoue et la reprend sans doublon', async () => {
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new Error('Serveur inaccessible'))
      .mockResolvedValue(dossier)
    const native = bridge({ inspectEnrollment: inspect })
    show(native)
    await connect()
    fireEvent.click(examine())
    await screen.findByRole('alert')
    expect(approve()).toBeDisabled()
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    expect(native.requestEnrollment).toHaveBeenCalledOnce()
    expect(approve()).toBeEnabled()
  })
  it('empêche les doubles taps pendant la préparation et l’approbation', async () => {
    let finishRequest: ((value: TabletAuthorization) => void) | undefined
    let finishApproval: ((value: TabletAuthorization) => void) | undefined
    const native = bridge({
      requestEnrollment: vi.fn(
        () =>
          new Promise<TabletAuthorization>((resolve) => {
            finishRequest = resolve
          }),
      ),
      managerOperation: vi.fn(
        () =>
          new Promise<TabletAuthorization>((resolve) => {
            finishApproval = resolve
          }),
      ),
    })
    show(native)
    await connect()
    fireEvent.click(examine())
    fireEvent.click(examine())
    expect(native.requestEnrollment).toHaveBeenCalledOnce()
    await act(async () => {
      finishRequest?.(pending)
    })
    await screen.findByText(/12 événements/)
    fireEvent.click(approve())
    fireEvent.click(approve())
    expect(native.managerOperation).toHaveBeenCalledOnce()
    await act(async () => {
      finishApproval?.({ status: 'authorized' })
    })
    await screen.findByText('Tablette autorisée pour la synchronisation')
  })
  it('invalide l’examen quand le remplacement change et conserve le refus explicite', async () => {
    const native = bridge({
      getStatus: vi.fn(async () => pending),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
    })
    show(native)
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    fireEvent.click(screen.getByText('Options avancées d’enrôlement'))
    fireEvent.change(screen.getByLabelText('Installation remplacée (si applicable)'), {
      target: { value: 'previous-installation' },
    })
    expect(approve()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refuser cette demande' }))
    expect(screen.getByRole('button', { name: 'Confirmer le refus' })).toBeDisabled()
    expect(native.managerOperation).not.toHaveBeenCalled()
  })
  it('garde la validation UUID dans les options avancées', async () => {
    show(bridge({ managerStatus: vi.fn(async () => ({ authenticated: true })) }))
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(screen.getByText('Options avancées d’enrôlement'))
    fireEvent.change(screen.getByLabelText('Organisation — Identifiant UUID'), {
      target: { value: 'invalide' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/UUID valide/)
    expect(examine()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Organisation — Identifiant UUID'), {
      target: { value: scope.organizationId },
    })
    fireEvent.change(screen.getByLabelText('Festival — Identifiant UUID'), {
      target: { value: '' },
    })
    expect(examine()).toBeDisabled()
  })
  it('ne présente pas une approbation refusée comme une réussite', async () => {
    const native = bridge({
      getStatus: vi.fn(async () => pending),
      managerStatus: vi.fn(async () => ({ authenticated: true })),
      managerOperation: vi.fn(async () => ({ status: 'authorization_denied' as const })),
    })
    show(native)
    await waitFor(() => expect(examine()).toBeEnabled())
    fireEvent.click(examine())
    await screen.findByText(/12 événements/)
    fireEvent.click(approve())
    await screen.findByRole('alert')
    expect(screen.queryByText('Tablette autorisée pour la synchronisation')).not.toBeInTheDocument()
  })
})
