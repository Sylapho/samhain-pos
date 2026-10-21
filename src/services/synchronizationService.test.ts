import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDbOutboxRepository } from './outboxRepository'

const bridge = vi.hoisted(() => ({
  getSyncDiagnostics: vi.fn(),
  retrySynchronization: vi.fn(),
  setSyncEnabled: vi.fn(),
  android: true,
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => bridge.android,
    getPlatform: () => (bridge.android ? 'android' : 'web'),
  },
  registerPlugin: () => bridge,
}))
import { synchronizationService } from './synchronizationService'

describe('Service de suivi et relance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.android = true
  })
  it('réutilise les diagnostics durables natifs', async () => {
    const diagnostics = { pendingEvents: 5, lastServerReceivedAt: '2026-10-21T12:32:00Z' }
    bridge.getSyncDiagnostics.mockResolvedValue(diagnostics)
    expect(await synchronizationService.diagnostics()).toBe(diagnostics)
  })
  it('regroupe les demandes simultanées et libère le verrou après erreur', async () => {
    let finish!: (value: { scheduled: boolean }) => void
    bridge.retrySynchronization.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = synchronizationService.retry()
    const second = synchronizationService.retry()
    expect(first).toBe(second)
    expect(bridge.retrySynchronization).toHaveBeenCalledTimes(1)
    finish({ scheduled: false })
    await expect(first).rejects.toThrow('Relance indisponible')
    bridge.retrySynchronization.mockResolvedValue({ scheduled: true })
    await synchronizationService.retry()
    expect(bridge.retrySynchronization).toHaveBeenCalledTimes(2)
  })
  it('le Web lit tous les types locaux sans promesse de transmission native', async () => {
    bridge.android = false
    vi.stubGlobal('indexedDB', new IDBFactory())
    const entries = vi.spyOn(IndexedDbOutboxRepository.prototype, 'entries').mockResolvedValue(
      ['sale', 'correction', 'closure', 'cash_session_opened', 'cash_float_updated'].map(
        (kind, index) => ({
          kind,
          status: index === 0 ? 'quarantined' : 'pending',
        }),
      ) as Awaited<ReturnType<IndexedDbOutboxRepository['entries']>>,
    )
    try {
      expect(await synchronizationService.diagnostics()).toMatchObject({
        pendingEvents: 5,
        pending: 4,
        sending: 0,
        errors: 1,
        authentication: 'native_only',
        lastSuccessAt: null,
        lastServerReceivedAt: null,
      })
      expect(bridge.getSyncDiagnostics).not.toHaveBeenCalled()
    } finally {
      entries.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
