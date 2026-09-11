import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import type { OrderPersistenceSnapshot } from './orderRepository'
import { IndexedDbOrderRepository } from './orderRepository'
import { createOrderDataRepository } from './orderRepositoryFactory'
import { OrderService } from './orderService'
import { RoomOrderRepository } from './roomOrderRepository'

const terminal = {
  terminalId: 'terminal-a',
  terminalCode: 'A' as const,
  displayName: 'Caisse A',
  provisionedAt: '2026-08-01T10:00:00.000Z',
}

function nativeStorage(initialStatus = false) {
  let completed = initialStatus
  let snapshot: OrderPersistenceSnapshot = {
    metadata: {
      nextOrderSequence: 1,
      nextReceiptSequence: 1,
      nextJournalSequence: 1,
      lastJournalHash: null,
    },
    orders: [],
    technicalStates: [],
    entries: [],
  }
  const bridge = {
    getLegacyMigrationStatus: vi.fn(async () => ({ completed })),
    importLegacySnapshot: vi.fn(async (value: OrderPersistenceSnapshot) => {
      snapshot = structuredClone(value)
      completed = true
      return {
        importedOrders: value.orders.length,
        importedEntries: value.entries.length,
        totalOrders: value.orders.length,
        totalEntries: value.entries.length,
      }
    }),
    createOrder: vi.fn(),
    getSnapshot: vi.fn(async () => structuredClone(snapshot)),
    compareAndSetPrinting: vi.fn(),
    recordCorrection: vi.fn(),
    closePeriod: vi.fn(),
    restoreSnapshot: vi.fn(),
  } satisfies ConstructorParameters<typeof RoomOrderRepository>[0]
  return bridge
}

describe('sélection et migration du repository Android Room', () => {
  it('sélectionne Room uniquement pour une exécution Android native', () => {
    const indexedDb = new IDBFactory()
    const bridge = nativeStorage(true)
    expect(
      createOrderDataRepository({
        platform: 'android',
        native: true,
        indexedDb,
        nativeStorage: bridge,
      }),
    ).toBeInstanceOf(RoomOrderRepository)
    expect(createOrderDataRepository({ platform: 'web', native: false, indexedDb })).toBeInstanceOf(
      IndexedDbOrderRepository,
    )
    expect(
      createOrderDataRepository({ platform: 'android', native: false, indexedDb }),
    ).toBeInstanceOf(IndexedDbOrderRepository)
  })

  it('importe une fois le snapshot IndexedDB complet avant toute lecture Room', async () => {
    const indexedDb = new IDBFactory()
    const legacy = new IndexedDbOrderRepository(indexedDb)
    const service = new OrderService(
      legacy,
      () => 'legacy-order',
      () => terminal,
    )
    await service.createOrder([], 'cash', new Date('2026-09-01T12:00:00.000Z'))
    await legacy.close()

    const bridge = nativeStorage()
    const repository = new RoomOrderRepository(bridge, indexedDb)
    expect((await repository.getOrders()).map((order) => order.id)).toEqual(['legacy-order'])
    expect(await repository.getOrders()).toHaveLength(1)
    expect(bridge.importLegacySnapshot).toHaveBeenCalledTimes(1)
    const imported = bridge.importLegacySnapshot.mock.calls[0]?.[0]
    expect(imported?.metadata).toMatchObject({
      nextOrderSequence: 2,
      nextReceiptSequence: 2,
      nextJournalSequence: 2,
    })
    expect(imported?.technicalStates[0]?.printing.status).toBe('pending')
    expect(imported?.entries[0]?.kind).toBe('sale')
  })

  it('n’ouvre pas IndexedDB lorsque la migration Room est déjà marquée terminée', async () => {
    const bridge = nativeStorage(true)
    const repository = new RoomOrderRepository(bridge, undefined)
    expect(await repository.getOrders()).toEqual([])
    expect(bridge.importLegacySnapshot).not.toHaveBeenCalled()
  })

  it('propage un conflit natif sans effacer la source IndexedDB', async () => {
    const indexedDb = new IDBFactory()
    const legacy = new IndexedDbOrderRepository(indexedDb)
    const service = new OrderService(
      legacy,
      () => 'legacy-order',
      () => terminal,
    )
    await service.createOrder([], 'cash', new Date('2026-09-01T12:00:00.000Z'))
    await legacy.close()

    const bridge = nativeStorage()
    bridge.importLegacySnapshot.mockRejectedValueOnce(new Error('Conflit UUID'))
    const repository = new RoomOrderRepository(bridge, indexedDb)
    await expect(repository.getOrders()).rejects.toThrow('Conflit UUID')

    const sourceStillPresent = new IndexedDbOrderRepository(indexedDb)
    expect((await sourceStillPresent.getOrders()).map((order) => order.id)).toEqual([
      'legacy-order',
    ])
    await sourceStillPresent.close()
  })
})
