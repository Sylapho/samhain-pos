import { Capacitor, registerPlugin } from '@capacitor/core'
import { IndexedDbOutboxRepository } from './outboxRepository'

export type SyncDiagnostics = {
  enabled: boolean
  chainId?: string
  pendingEvents: number
  pending: number
  sending: number
  errors: number
  authentication: string
  continuity: 'verified' | 'unknown' | 'failed'
  backfillComplete: boolean
  lastSuccessAt: number | null
  lastError: string | null
}

interface NativeSyncDiagnostics {
  getSyncDiagnostics(): Promise<SyncDiagnostics>
  retrySynchronization(): Promise<{ scheduled: boolean }>
  setSyncEnabled(options: { enabled: boolean }): Promise<{ updated: boolean }>
}

const native = registerPlugin<NativeSyncDiagnostics>('OrderStorage')
const isAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

export const synchronizationService = {
  async diagnostics(): Promise<SyncDiagnostics> {
    if (isAndroid()) return native.getSyncDiagnostics()
    const outbox = new IndexedDbOutboxRepository(globalThis.indexedDB)
    const entries = await outbox.entries()
    return {
      pendingEvents: entries.filter((entry) => entry.status !== 'synced').length,
      pending: entries.filter((entry) => entry.status === 'pending').length,
      sending: entries.filter((entry) => entry.status === 'sending').length,
      errors: entries.filter((entry) =>
        ['paused_auth', 'needs_recovery', 'quarantined'].includes(entry.status),
      ).length,
      authentication: 'native_only',
      enabled: false,
      continuity: 'unknown',
      backfillComplete: false,
      lastSuccessAt: null,
      lastError: null,
    }
  },
  async retry(): Promise<void> {
    if (isAndroid()) {
      await native.retrySynchronization()
      return
    }
    const outbox = new IndexedDbOutboxRepository(globalThis.indexedDB)
    while (!(await outbox.backfillBatch())) {
      /* Only local capture in the browser preview. */
    }
  },
  async setEnabled(enabled: boolean): Promise<void> {
    if (!isAndroid()) throw new Error('Les échanges sécurisés sont disponibles sur Android.')
    await native.setSyncEnabled({ enabled })
  },
  async requireSafeToReprovision(): Promise<void> {
    const state = await this.diagnostics()
    if (
      ![state.pendingEvents, state.sending, state.errors].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      )
    )
      throw new Error('Impossible de vérifier les événements en attente.')
    if (state.pendingEvents > 0 || state.sending > 0)
      throw new Error(
        'Des événements ne sont pas acquittés. Attendez leur vérification avant de changer de caisse.',
      )
    if (
      !state.backfillComplete ||
      state.errors > 0 ||
      state.continuity !== 'verified' ||
      !['authorized', 'session_expired'].includes(state.authentication)
    )
      throw new Error('La continuité du journal doit être vérifiée avant de changer de caisse.')
  },
}
