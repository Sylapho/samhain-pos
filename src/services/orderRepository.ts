import type { Order } from '../types/order'

const ORDERS_STORE = 'orders'
const METADATA_STORE = 'metadata'
const SEQUENCES_KEY = 'sequences'

type StoredSequences = {
  key: typeof SEQUENCES_KEY
  nextOrderSequence: number
  nextReceiptSequence: number
}

export type AllocatedOrderSequences = {
  orderSequence: number
  receiptSequence: number
}

export interface OrderRepository {
  createOrder(buildOrder: (sequences: AllocatedOrderSequences) => Order): Promise<Order>
  getOrders(): Promise<Order[]>
}

export class IndexedDbOrderRepository implements OrderRepository {
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = 'samhain-pos',
  ) {}

  createOrder(buildOrder: (sequences: AllocatedOrderSequences) => Order): Promise<Order> {
    return this.openDatabase().then(
      (database) =>
        new Promise<Order>((resolve, reject) => {
          const transaction = database.transaction([ORDERS_STORE, METADATA_STORE], 'readwrite')
          const orders = transaction.objectStore(ORDERS_STORE)
          const metadata = transaction.objectStore(METADATA_STORE)
          const sequenceRequest = metadata.get(SEQUENCES_KEY)
          let createdOrder: Order | null = null
          let operationError: unknown

          sequenceRequest.onsuccess = () => {
            try {
              const stored = sequenceRequest.result as StoredSequences | undefined
              if (
                stored &&
                (!Number.isSafeInteger(stored.nextOrderSequence) ||
                  stored.nextOrderSequence < 1 ||
                  stored.nextOrderSequence >= Number.MAX_SAFE_INTEGER ||
                  !Number.isSafeInteger(stored.nextReceiptSequence) ||
                  stored.nextReceiptSequence < 1 ||
                  stored.nextReceiptSequence >= Number.MAX_SAFE_INTEGER)
              ) {
                throw new Error('Les séquences locales de commande sont invalides.')
              }
              const sequences: AllocatedOrderSequences = {
                orderSequence: stored?.nextOrderSequence ?? 1,
                receiptSequence: stored?.nextReceiptSequence ?? 1,
              }
              createdOrder = buildOrder(sequences)

              const metadataRequest = metadata.put({
                key: SEQUENCES_KEY,
                nextOrderSequence: sequences.orderSequence + 1,
                nextReceiptSequence: sequences.receiptSequence + 1,
              } satisfies StoredSequences)
              const orderRequest = orders.add(createdOrder)
              metadataRequest.onerror = () => {
                operationError = metadataRequest.error ?? new Error('Échec de la séquence locale.')
              }
              orderRequest.onerror = () => {
                operationError = orderRequest.error ?? new Error('Échec de la commande locale.')
              }
            } catch (error) {
              operationError = error
              transaction.abort()
            }
          }

          transaction.oncomplete = () => {
            if (createdOrder) resolve(createdOrder)
            else reject(new Error('La commande locale n’a pas été créée.'))
          }
          transaction.onerror = () => {
            operationError ??= transaction.error ?? new Error('Échec de la transaction locale.')
          }
          transaction.onabort = () =>
            reject(operationError ?? transaction.error ?? new Error('Transaction locale annulée.'))
        }),
    )
  }

  getOrders(): Promise<Order[]> {
    return this.openDatabase().then(
      (database) =>
        new Promise<Order[]>((resolve, reject) => {
          const transaction = database.transaction(ORDERS_STORE, 'readonly')
          const request = transaction.objectStore(ORDERS_STORE).getAll()

          request.onsuccess = () => resolve(request.result as Order[])
          request.onerror = () =>
            reject(request.error ?? new Error('Lecture des commandes locales impossible.'))
        }),
    )
  }

  async close(): Promise<void> {
    if (!this.databasePromise) return
    const database = await this.databasePromise
    database.close()
    this.databasePromise = null
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise

    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1)

      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(ORDERS_STORE)) {
          database.createObjectStore(ORDERS_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        this.databasePromise = null
        reject(request.error ?? new Error('Ouverture du stockage local impossible.'))
      }
    })

    return this.databasePromise
  }
}
