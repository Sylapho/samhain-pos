import { beforeEach, describe, expect, it } from 'vitest'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
} from './terminalConfigurationService'
import {
  LocalStorageResponsibleCredentialRepository,
  RESPONSIBLE_MODE_IDLE_TIMEOUT_MS,
  ResponsibleModeService,
} from './responsibleModeService'

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
      () => {},
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
      () => {},
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

  it('refuse le reprovisionnement avant tout effet lorsque le mode responsable est verrouillé', () => {
    const repository = new LocalStorageTerminalConfigurationRepository(localStorage)
    const initialService = new TerminalConfigurationService(repository, () => 'terminal-a')
    const initial = initialService.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    let idCalls = 0
    const locked = new TerminalConfigurationService(
      repository,
      () => {
        idCalls += 1
        return 'terminal-b'
      },
      () => {
        throw new Error('Mode responsable requis pour cette opération.')
      },
    )

    expect(() => locked.reprovision({ terminalCode: 'B', displayName: 'Caisse B' })).toThrow(
      /Mode responsable requis/,
    )
    expect(() => locked.rename('Caisse accueil')).toThrow(/Mode responsable requis/)
    expect(idCalls).toBe(0)
    expect(repository.get()).toEqual(initial)
  })

  it('refuse le reprovisionnement après expiration de la session responsable', async () => {
    let now = 1_000
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
      globalThis.crypto,
      () => now,
    )
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'terminal-b',
      () => responsibleMode.requireUnlocked(),
    )
    service.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    await responsibleMode.setupPin('4826', '4826')
    now += RESPONSIBLE_MODE_IDLE_TIMEOUT_MS + 1

    expect(() => service.reprovision({ terminalCode: 'B', displayName: 'Caisse B' })).toThrow(
      /expiré/,
    )
    expect(service.getRequiredConfiguration()).toMatchObject({
      terminalId: 'terminal-b',
      terminalCode: 'A',
    })
  })

  it('reprovisionne après un déverrouillage responsable réussi', async () => {
    const responsibleMode = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(localStorage),
    )
    let nextId = 0
    const service = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => `terminal-${++nextId}`,
      () => responsibleMode.requireUnlocked(),
    )
    service.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    await responsibleMode.setupPin('4826', '4826')

    expect(service.reprovision({ terminalCode: 'B', displayName: 'Caisse B' })).toMatchObject({
      terminalId: 'terminal-2',
      terminalCode: 'B',
      displayName: 'Caisse B',
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
