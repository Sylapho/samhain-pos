import { beforeEach, describe, expect, it } from 'vitest'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
} from './terminalConfigurationService'

describe('configuration persistante du terminal', () => {
  beforeEach(() => localStorage.clear())

  it('conserve le même UUID après recréation du service', () => {
    const repository = new LocalStorageTerminalConfigurationRepository(localStorage)
    const first = new TerminalConfigurationService(repository, () => 'terminal-stable')
    const provisioned = first.provision(
      { terminalCode: 'B', displayName: 'Caisse bar' },
      new Date('2026-09-01T10:00:00Z'),
    )

    const restarted = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'unused-id',
    )

    expect(restarted.getRequiredConfiguration()).toEqual(provisioned)
    expect(restarted.getRequiredConfiguration().terminalId).toBe('terminal-stable')
  })

  it('renomme la caisse sans changer son identité ni sa date de provisioning', () => {
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'terminal-a',
    )
    const initial = service.provision(
      { terminalCode: 'A', displayName: 'Caisse A' },
      new Date('2026-09-01T10:00:00Z'),
    )

    const renamed = service.rename('  Caisse accueil  ')

    expect(renamed).toEqual({ ...initial, displayName: 'Caisse accueil' })
  })

  it('exige une action de reprovisionnement pour remplacer une identité existante', () => {
    let nextId = 0
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => `terminal-${++nextId}`,
    )
    service.provision({ terminalCode: 'A', displayName: 'Caisse A' })

    expect(() => service.provision({ terminalCode: 'B', displayName: 'Caisse B' })).toThrow(
      /déjà configurée/,
    )

    const reprovisioned = service.reprovision(
      { terminalCode: 'B', displayName: 'Caisse B' },
      new Date('2026-09-02T10:00:00Z'),
    )
    expect(reprovisioned).toMatchObject({
      terminalId: 'terminal-2',
      terminalCode: 'B',
      displayName: 'Caisse B',
      provisionedAt: '2026-09-02T10:00:00.000Z',
    })
  })

  it('refuse un nom visible vide', () => {
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'terminal-a',
    )

    expect(() => service.provision({ terminalCode: 'A', displayName: '   ' })).toThrow(
      /obligatoire/,
    )
    expect(service.getConfiguration()).toBeNull()
  })
})
