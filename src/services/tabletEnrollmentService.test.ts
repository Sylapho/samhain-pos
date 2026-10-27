import { describe, expect, it, vi } from 'vitest'
import { TabletEnrollmentService } from './tabletEnrollmentService'
import type { NativeTabletAuth } from '../native/tabletAuth'

function bridge(): NativeTabletAuth {
  return {
    getStatus: vi.fn(async () => ({ status: 'revoked' as const })),
    requestEnrollment: vi.fn(async () => ({ status: 'pending' as const })),
    activate: vi.fn(async () => ({ status: 'authorized' as const })),
    prepareReplacement: vi.fn(async () => ({ status: 'needs_recovery' as const })),
    inspectEnrollment: vi.fn(),
    managerLogin: vi.fn(async () => ({ status: 'authenticated' as const })),
    managerStatus: vi.fn(async () => ({ authenticated: false })),
    managerLogout: vi.fn(async () => {}),
    managerOperation: vi.fn(async () => ({ status: 'revoked' as const })),
  }
}
describe('enrôlement natif séparé des opérations locales', () => {
  it('refuse les UUID invalides avant le bridge et normalise les valeurs valides', async () => {
    const native = bridge()
    const service = new TabletEnrollmentService(native, true, () => {})
    await expect(
      service.request({
        terminalId: 'terminal',
        organizationId: 'bad',
        festivalId: '',
        reconnect: false,
      }),
    ).rejects.toThrow(/UUID valide/)
    expect(native.requestEnrollment).not.toHaveBeenCalled()
    await service.request({
      terminalId: 'terminal',
      organizationId: ' A1B6B2AB-E2E9-4A81-B5C1-56C54D7D22F3 ',
      festivalId: '18bdec64-385a-4f86-958f-184a81635c96',
      reconnect: false,
    })
    expect(native.requestEnrollment).toHaveBeenCalledWith({
      terminalId: 'terminal',
      organizationId: 'a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3',
      festivalId: '18bdec64-385a-4f86-958f-184a81635c96',
      reconnect: false,
    })
  })
  it('ne transforme pas une connexion responsable refusée en expiration de la session tablette', async () => {
    const native = bridge()
    native.managerOperation = vi.fn(async () => ({ status: 'session_expired' as const }))
    const service = new TabletEnrollmentService(native, true, () => {})
    await expect(
      service.manager({
        action: 'approve',
        body: { chainId: 'chain' },
      }),
    ).rejects.toThrow(/compte responsable/)
    expect(native.requestEnrollment).not.toHaveBeenCalled()
  })
  it('n’appelle aucun réseau pour une configuration absente', async () => {
    const native = bridge()
    expect(await new TabletEnrollmentService(native, false).status(true)).toEqual({
      status: 'not_configured',
    })
    expect(native.getStatus).not.toHaveBeenCalled()
  })
  it('ne simule pas d’enrôlement Web', async () => {
    const service = new TabletEnrollmentService(null, true, () => {})
    expect(await service.status()).toEqual({ status: 'not_enrolled' })
    await expect(
      service.request({
        terminalId: 'terminal',
        organizationId: '',
        festivalId: '',
        reconnect: false,
      }),
    ).rejects.toThrow(/Android/)
  })
  it('requiert le responsable pour toutes les opérations actives', async () => {
    const native = bridge()
    const service = new TabletEnrollmentService(native, true, () => {
      throw new Error('verrouillé')
    })
    await expect(
      service.request({
        terminalId: 'terminal',
        organizationId: '',
        festivalId: '',
        reconnect: false,
      }),
    ).rejects.toThrow('verrouillé')
    await expect(service.activate('code')).rejects.toThrow('verrouillé')
    await expect(service.status(true)).rejects.toThrow('verrouillé')
    await expect(service.managerStatus()).rejects.toThrow('verrouillé')
    expect(native.managerStatus).not.toHaveBeenCalled()
    expect(native.requestEnrollment).not.toHaveBeenCalled()
  })
  it('relit seulement le statut natif sans relancer une connexion responsable', async () => {
    const native = bridge()
    native.managerStatus = vi.fn(async () => ({ authenticated: true }))
    const service = new TabletEnrollmentService(native, true, () => {})
    expect(await service.managerStatus()).toBe(true)
    expect(native.managerLogin).not.toHaveBeenCalled()
    native.managerStatus = vi.fn(async () => ({ authenticated: false }))
    expect(await service.managerStatus()).toBe(false)
  })
  it('transmet la révocation sans toucher un repository financier', async () => {
    const service = new TabletEnrollmentService(bridge(), true, () => {})
    expect(await service.status()).toEqual({ status: 'revoked' })
  })
})
