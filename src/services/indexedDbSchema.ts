export const SAMHAIN_DATABASE_VERSION = 6

export const indexedDbStores = {
  outbox: 'outbox',
  syncMetadata: 'syncMetadata',
  orders: 'orders',
  orderTechnicalState: 'orderTechnicalState',
  salesLedger: 'salesLedger',
  metadata: 'metadata',
  checkoutIntents: 'checkoutIntents',
  products: 'products',
  categories: 'categories',
  catalogMetadata: 'catalogMetadata',
} as const

export function openSamhainDatabase(
  indexedDb: IDBFactory,
  databaseName = 'samhain-pos',
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, SAMHAIN_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(indexedDbStores.outbox)) {
        const outbox = database.createObjectStore(indexedDbStores.outbox, { keyPath: 'eventId' })
        outbox.createIndex('chainSequence', ['chainId', 'sequence'], { unique: true })
        outbox.createIndex('statusNextAttempt', ['status', 'nextAttemptAt'])
      }
      if (!database.objectStoreNames.contains(indexedDbStores.syncMetadata)) {
        const sync = database.createObjectStore(indexedDbStores.syncMetadata, { keyPath: 'key' })
        sync.add({ key: 'identity', chainId: globalThis.crypto.randomUUID() })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.orders)) {
        database.createObjectStore(indexedDbStores.orders, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.metadata)) {
        database.createObjectStore(indexedDbStores.metadata, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.orderTechnicalState)) {
        database.createObjectStore(indexedDbStores.orderTechnicalState, { keyPath: 'orderId' })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.salesLedger)) {
        database.createObjectStore(indexedDbStores.salesLedger, { keyPath: 'id' })
      }
      const ledger = request.transaction!.objectStore(indexedDbStores.salesLedger)
      if (!ledger.indexNames.contains('sequence'))
        ledger.createIndex('sequence', 'sequence', { unique: true })
      if (!database.objectStoreNames.contains(indexedDbStores.checkoutIntents)) {
        const intents = database.createObjectStore(indexedDbStores.checkoutIntents, {
          keyPath: 'id',
        })
        intents.createIndex('status', 'status', { unique: false })
        intents.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.categories)) {
        database.createObjectStore(indexedDbStores.categories, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.products)) {
        const products = database.createObjectStore(indexedDbStores.products, { keyPath: 'id' })
        products.createIndex('active', 'active', { unique: false })
        products.createIndex('categoryId', 'categoryId', { unique: false })
        products.createIndex('displayOrder', 'displayOrder', { unique: false })
      }
      if (!database.objectStoreNames.contains(indexedDbStores.catalogMetadata)) {
        database.createObjectStore(indexedDbStores.catalogMetadata, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () =>
      reject(request.error ?? new Error('Ouverture du stockage local impossible.'))
    request.onblocked = () =>
      reject(new Error('Mise à niveau du stockage bloquée par un autre onglet ouvert.'))
  })
}
