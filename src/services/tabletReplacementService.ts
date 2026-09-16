import type { ArchiveRestoreResult, SalesArchive } from '../types/salesLedger'
import type { TerminalIdentity } from '../types/terminal'
import type { SalesLedgerRepository } from './orderRepository'
import { verifySalesArchive } from './orderRepository'
import { getResponsibleModeService } from './responsibleModeService'
import { requireArchiveTerminalIdentity } from './salesLedgerService'
import type { TerminalConfigurationService } from './terminalConfigurationService'

const TABLET_REPLACEMENT_STATE_KEY = 'samhain-pos.tablet-replacement.v1'

export type PendingTabletReplacement = {
  schemaVersion: 1
  archiveHash: string
  terminal: TerminalIdentity
  startedAt: string
}

export interface TabletReplacementStateRepository {
  get(): PendingTabletReplacement | null
  save(state: PendingTabletReplacement): void
  clear(): void
}

export class LocalStorageTabletReplacementStateRepository implements TabletReplacementStateRepository {
  constructor(private readonly storage: Storage) {}

  get(): PendingTabletReplacement | null {
    const serialized = this.storage.getItem(TABLET_REPLACEMENT_STATE_KEY)
    if (!serialized) return null
    try {
      const state = JSON.parse(serialized) as Partial<PendingTabletReplacement>
      if (
        state.schemaVersion !== 1 ||
        typeof state.archiveHash !== 'string' ||
        !state.archiveHash ||
        !state.terminal ||
        typeof state.terminal.terminalId !== 'string' ||
        typeof state.terminal.terminalCode !== 'string' ||
        typeof state.terminal.displayName !== 'string' ||
        typeof state.startedAt !== 'string'
      ) {
        throw new Error('État de remplacement invalide.')
      }
      return state as PendingTabletReplacement
    } catch {
      throw new Error(
        'La reprise du remplacement de tablette est bloquée : son état local est illisible.',
      )
    }
  }

  save(state: PendingTabletReplacement): void {
    this.storage.setItem(TABLET_REPLACEMENT_STATE_KEY, JSON.stringify(state))
  }

  clear(): void {
    this.storage.removeItem(TABLET_REPLACEMENT_STATE_KEY)
  }
}

export class TabletReplacementService {
  constructor(
    private readonly repository: SalesLedgerRepository,
    private readonly terminalConfiguration: TerminalConfigurationService,
    private readonly stateRepository: TabletReplacementStateRepository,
    private readonly requireResponsibleMode: () => void = () =>
      getResponsibleModeService().requireUnlocked(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async replaceFromArchive(archive: SalesArchive): Promise<ArchiveRestoreResult> {
    this.requireResponsibleMode()
    const verification = verifySalesArchive(archive)
    if (!verification.valid) {
      throw new Error(`Restauration refusée : ${verification.errors.join(' ')}`)
    }
    const source = requireArchiveTerminalIdentity(archive)
    const pending = this.stateRepository.get()
    if (pending && !sameReplacement(pending, archive)) {
      throw new Error(
        'Un autre remplacement de tablette est déjà en attente. Reprenez-le avec la même archive.',
      )
    }

    const current = this.terminalConfiguration.getConfiguration()
    if (
      current &&
      (current.terminalId !== source.terminalId || current.terminalCode !== source.terminalCode)
    ) {
      throw new Error('Cette archive appartient à une autre identité de caisse.')
    }

    let targetState = await this.repository.getArchiveRestoreTargetState(archive)
    if (current) {
      if (targetState !== 'matches-archive') {
        throw new Error(
          'Cette tablette est déjà configurée. Utilisez la restauration standard pour cette identité.',
        )
      }
      this.stateRepository.clear()
      return restoreResult(archive)
    }
    if (targetState === 'occupied') {
      throw new Error('Le remplacement exige une base locale vide et ne fusionne aucun journal.')
    }
    if (
      targetState === 'matches-archive' &&
      !pending &&
      (archive.orders.length > 0 || archive.entries.length > 0)
    ) {
      throw new Error(
        'Un journal existe sans identité de remplacement vérifiable. Aucun encaissement ne doit reprendre.',
      )
    }

    if (!pending) {
      this.stateRepository.save({
        schemaVersion: 1,
        archiveHash: archive.archiveHash,
        terminal: structuredClone(source),
        startedAt: this.now().toISOString(),
      })
    }

    let result = restoreResult(archive)
    if (targetState === 'empty') {
      result = await this.repository.restoreArchive(archive)
      targetState = await this.repository.getArchiveRestoreTargetState(archive)
      if (targetState !== 'matches-archive') {
        throw new Error(
          'La restauration a été interrompue avant sa vérification finale. Aucun encaissement ne doit reprendre.',
        )
      }
    }

    this.terminalConfiguration.adoptRestoredIdentity(source, this.now())
    this.stateRepository.clear()
    return result
  }
}

function sameReplacement(state: PendingTabletReplacement, archive: SalesArchive): boolean {
  return (
    state.archiveHash === archive.archiveHash &&
    state.terminal.terminalId === archive.source.terminal.terminalId &&
    state.terminal.terminalCode === archive.source.terminal.terminalCode
  )
}

function restoreResult(archive: SalesArchive): ArchiveRestoreResult {
  return {
    restoredOrders: archive.orders.length,
    restoredEntries: archive.entries.length,
  }
}

export function hasPendingTabletReplacement(storage: Storage = globalThis.localStorage): boolean {
  return new LocalStorageTabletReplacementStateRepository(storage).get() !== null
}
