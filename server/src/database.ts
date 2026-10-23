import { MongoClient } from 'mongodb'
import type { MongoClientOptions, Document } from 'mongodb'
import type { Config } from './config.ts'

export interface Database {
  connect(): Promise<void>
  check(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface DriverClient {
  connect(): Promise<unknown>
  close(): Promise<void>
  db(name: string): {
    databaseName: string
    command(
      command: Document,
      options: { timeoutMS: number; maxTimeMS: number; signal?: AbortSignal },
    ): Promise<unknown>
  }
}

export function createDatabase(
  config: Config,
  factory: (uri: string, options: MongoClientOptions) => DriverClient = (uri, options) =>
    new MongoClient(uri, options),
): Database {
  const client = factory(config.mongoUri, {
    appName: 'samhain-api',
    tls: config.mongoTls,
    minPoolSize: config.poolMin,
    maxPoolSize: config.poolMax,
    maxConnecting: 2,
    maxIdleTimeMS: 60000,
    connectTimeoutMS: config.connectTimeoutMs,
    serverSelectionTimeoutMS: config.selectionTimeoutMs,
    socketTimeoutMS: config.socketTimeoutMs,
    timeoutMS: config.operationTimeoutMs,
    waitQueueTimeoutMS: config.operationTimeoutMs,
    monitorCommands: false,
  })
  const db = client.db(config.mongoDatabase)
  let connection: Promise<void> | undefined
  let closing: Promise<void> | undefined
  return {
    connect() {
      if (closing) return Promise.reject(new Error('Database closed'))
      connection ??= client.connect().then(() => undefined)
      return connection
    },
    async check(signal) {
      if (closing) throw new Error('Database closed')
      await db.command(
        { ping: 1 },
        {
          timeoutMS: config.readinessTimeoutMs,
          maxTimeMS: config.readinessTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      )
    },
    close() {
      closing ??= client.close()
      return closing
    },
  }
}
