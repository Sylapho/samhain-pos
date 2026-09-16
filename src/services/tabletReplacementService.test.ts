import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createValidOrderItems } from '../test/orderFixtures'
import type { SalesArchive } from '../types/salesLedger'
import type { TerminalConfiguration } from '../types/terminal'
import { IndexedDbOrderRepository } from './orderRepository'
import { OrderService } from './orderService'
import { SalesLedgerService } from './salesLedgerService'
import {
  LocalStorageTabletReplacementStateRepository,
  TabletReplacementService,
  type TabletReplacementStateRepository,
} from './tabletReplacementService'
import {
  LocalStorageTerminalConfigurationRepository,
  TerminalConfigurationService,
  type TerminalConfigurationRepository,
} from './terminalConfigurationService'

const sourceTerminal: TerminalConfiguration = {
  terminalId: 'terminal-b',
  terminalCode: 'B',
  displayName: 'Caisse B',
  provisionedAt: '2026-09-01T08:00:00.000Z',
}

async function createArchive(indexedDb: IDBFactory): Promise<{
  archive: SalesArchive
  repository: IndexedDbOrderRepository
}> {
  const repository = new IndexedDbOrderRepository(indexedDb, 'replacement-source')
  const orders = new OrderService(
    repository,
    () => 'source-order',
    () => sourceTerminal,
  )
  await orders.createOrder(createValidOrderItems(), 'cash', new Date('2026-09-01T10:00:00Z'))
  const ledger = new SalesLedgerService(
    repository,
    () => 'archive-id',
    () => sourceTerminal,
    undefined,
    () => {},
  )
  return {
    archive: await ledger.exportArchive('archive-b', new Date('2026-09-01T11:00:00Z')),
    repository,
  }
}

describe('remplacement contrôlé de tablette', () => {
  beforeEach(() => localStorage.clear())

  it('exige le mode responsable avant toute validation ou lecture de la cible', async () => {
    const stateRepository = {
      get: vi.fn(),
      save: vi.fn(),
      clear: vi.fn(),
    } satisfies TabletReplacementStateRepository
    const terminalService = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
    )
    const replacement = new TabletReplacementService(
      {} as ConstructorParameters<typeof TabletReplacementService>[0],
      terminalService,
      stateRepository,
      () => {
        throw new Error('Mode responsable requis pour cette opération.')
      },
    )

    await expect(replacement.replaceFromArchive({} as SalesArchive)).rejects.toThrow(
      /Mode responsable requis/,
    )
    expect(stateRepository.get).not.toHaveBeenCalled()
  })

  it('adopte aussi une archive vérifiée encore vide sans inventer de journal', async () => {
    const indexedDb = new IDBFactory()
    const sourceRepository = new IndexedDbOrderRepository(indexedDb, 'empty-source')
    const sourceLedger = new SalesLedgerService(
      sourceRepository,
      () => 'empty-archive',
      () => sourceTerminal,
      undefined,
      () => {},
    )
    const archive = await sourceLedger.exportArchive(
      'empty-archive',
      new Date('2026-09-01T09:00:00Z'),
    )
    const target = new IndexedDbOrderRepository(indexedDb, 'empty-target')
    const terminalService = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'must-not-be-generated',
      () => {},
    )
    const replacement = new TabletReplacementService(
      target,
      terminalService,
      new LocalStorageTabletReplacementStateRepository(localStorage),
      () => {},
    )

    await expect(replacement.replaceFromArchive(archive)).resolves.toEqual({
      restoredOrders: 0,
      restoredEntries: 0,
    })
    expect(terminalService.getRequiredConfiguration()).toMatchObject({
      terminalId: 'terminal-b',
      terminalCode: 'B',
    })
    expect(await target.getOrders()).toEqual([])
    await Promise.all([sourceRepository.close(), target.close()])
  })

  it('restaure une identité exacte et reprend les séquences de l’archive', async () => {
    const indexedDb = new IDBFactory()
    const source = await createArchive(indexedDb)
    const target = new IndexedDbOrderRepository(indexedDb, 'replacement-target')
    const terminalService = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'must-not-be-generated',
      () => {},
    )
    const replacement = new TabletReplacementService(
      target,
      terminalService,
      new LocalStorageTabletReplacementStateRepository(localStorage),
      () => {},
      () => new Date('2026-09-02T08:00:00Z'),
    )

    await expect(replacement.replaceFromArchive(source.archive)).resolves.toEqual({
      restoredOrders: 1,
      restoredEntries: 1,
    })
    expect(terminalService.getRequiredConfiguration()).toEqual({
      ...sourceTerminal,
      provisionedAt: '2026-09-02T08:00:00.000Z',
    })
    expect((await target.verifyIntegrity()).valid).toBe(true)

    const orders = new OrderService(
      target,
      () => 'next-order',
      () => terminalService.getRequiredConfiguration(),
    )
    const next = await orders.createOrder(
      createValidOrderItems(),
      'card',
      new Date('2026-09-02T09:00:00Z'),
    )
    expect(next).toMatchObject({
      orderNumber: 'B-0002',
      terminal: { terminalId: 'terminal-b', terminalCode: 'B' },
      integrity: { journalSequence: 2 },
    })
    await Promise.all([source.repository.close(), target.close()])
  })

  it('refuse une archive d’une autre identité avant toute mutation', async () => {
    const indexedDb = new IDBFactory()
    const source = await createArchive(indexedDb)
    const target = new IndexedDbOrderRepository(indexedDb, 'replacement-mismatch')
    const terminalService = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(localStorage),
      () => 'terminal-a',
      () => {},
    )
    const initial = terminalService.provision({ terminalCode: 'A', displayName: 'Caisse A' })
    const state = new LocalStorageTabletReplacementStateRepository(localStorage)
    const replacement = new TabletReplacementService(target, terminalService, state, () => {})

    await expect(replacement.replaceFromArchive(source.archive)).rejects.toThrow(
      /autre identité de caisse/,
    )
    expect(terminalService.getRequiredConfiguration()).toEqual(initial)
    expect(await target.getOrders()).toEqual([])
    expect(await target.getLedgerEntries()).toEqual([])
    expect(state.get()).toBeNull()
    await Promise.all([source.repository.close(), target.close()])
  })

  it('reprend sans second restore après un échec d’écriture de l’identité locale', async () => {
    const indexedDb = new IDBFactory()
    const source = await createArchive(indexedDb)
    const target = new IndexedDbOrderRepository(indexedDb, 'replacement-resume')
    const restore = vi.spyOn(target, 'restoreArchive')
    let configuration: TerminalConfiguration | null = null
    let failSave = true
    const terminalRepository: TerminalConfigurationRepository = {
      get: () => configuration,
      save: (value) => {
        if (failSave) {
          failSave = false
          throw new Error('localStorage indisponible')
        }
        configuration = value
      },
    }
    let pending: ReturnType<TabletReplacementStateRepository['get']> = null
    const stateRepository: TabletReplacementStateRepository = {
      get: () => pending,
      save: (value) => {
        pending = structuredClone(value)
      },
      clear: () => {
        pending = null
      },
    }
    const terminalService = new TerminalConfigurationService(
      terminalRepository,
      () => 'must-not-be-generated',
      () => {},
    )
    const replacement = new TabletReplacementService(
      target,
      terminalService,
      stateRepository,
      () => {},
      () => new Date('2026-09-02T08:00:00Z'),
    )

    await expect(replacement.replaceFromArchive(source.archive)).rejects.toThrow(
      /localStorage indisponible/,
    )
    expect(stateRepository.get()?.archiveHash).toBe(source.archive.archiveHash)
    expect(await target.getArchiveRestoreTargetState(source.archive)).toBe('matches-archive')

    await expect(replacement.replaceFromArchive(source.archive)).resolves.toEqual({
      restoredOrders: 1,
      restoredEntries: 1,
    })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(configuration).toMatchObject({ terminalId: 'terminal-b', terminalCode: 'B' })
    expect(stateRepository.get()).toBeNull()
    await Promise.all([source.repository.close(), target.close()])
  })
})
