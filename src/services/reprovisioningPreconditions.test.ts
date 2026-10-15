import { describe, expect, it } from 'vitest'
import {
  SyncReprovisioningPreconditions,
  type ReprovisioningSyncState,
} from './reprovisioningPreconditions'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
} from './terminalConfigurationService'

describe('préconditions de changement de caisse', () => {
  const safe: ReprovisioningSyncState = {
    pendingEvents: 0,
    transferring: false,
    unresolvedError: false,
    continuity: 'verified',
  }
  it.each([
    null,
    { ...safe, pendingEvents: 1 },
    { ...safe, pendingEvents: -1 },
    { ...safe, transferring: true },
    { ...safe, unresolvedError: true },
    { ...safe, continuity: 'failed' as const },
    { ...safe, continuity: 'unknown' as const },
  ])('refuse au niveau métier sans modifier l’identité : %j', (state) => {
    localStorage.clear()
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => crypto.randomUUID(),
      () => {},
      new SyncReprovisioningPreconditions(() => state),
    )
    const initial = service.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    expect(() => service.reprovision({ terminalCode: 'B', displayName: 'Caisse B' })).toThrow()
    expect(service.getConfiguration()).toEqual(initial)
    expect(service.rename('Accueil').terminalId).toBe(initial.terminalId)
  })
  it('relit les préconditions à chaque mutation', () => {
    let state = safe
    const guard = new SyncReprovisioningPreconditions(() => state)
    expect(() => guard.requireSafeToReprovision()).not.toThrow()
    state = { ...safe, pendingEvents: 2 }
    expect(() => guard.requireSafeToReprovision()).toThrow(/acquittés/)
  })
  it('attend une preuve durable avant de changer l’identité et conserve celle-ci si la preuve échoue', async () => {
    localStorage.clear()
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => crypto.randomUUID(),
      () => {},
    )
    const original = service.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    await expect(
      service.reprovisionWithVerifiedSync(
        { terminalCode: 'B', displayName: 'Caisse B' },
        async () => {
          throw new Error('pending')
        },
      ),
    ).rejects.toThrow('pending')
    expect(service.getConfiguration()).toEqual(original)
    const next = await service.reprovisionWithVerifiedSync(
      { terminalCode: 'B', displayName: 'Caisse B' },
      async () => {},
    )
    expect(next.terminalId).not.toBe(original.terminalId)
    expect(next.terminalCode).toBe('B')
  })
})
