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
    managerLogout: vi.fn(async () => {}),
    managerOperation: vi.fn(async () => ({ status: 'revoked' as const })),
  }
}
describe('enrôlement natif séparé des opérations locales', () => {
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
    await expect(service.request('terminal')).rejects.toThrow(/Android/)
  })
  it('requiert le responsable pour toutes les opérations actives', async () => {
    const native = bridge()
    const service = new TabletEnrollmentService(native, true, () => {
      throw new Error('verrouillé')
    })
    await expect(service.request('terminal')).rejects.toThrow('verrouillé')
    await expect(service.activate('code')).rejects.toThrow('verrouillé')
    await expect(service.status(true)).rejects.toThrow('verrouillé')
    expect(native.requestEnrollment).not.toHaveBeenCalled()
  })
  it('transmet la révocation sans toucher un repository financier', async () => {
    const service = new TabletEnrollmentService(bridge(), true, () => {})
    expect(await service.status()).toEqual({ status: 'revoked' })
  })
})
