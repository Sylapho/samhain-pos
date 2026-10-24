import { MongoClient } from 'mongodb'
import type { MongoClientOptions, Document, Db } from 'mongodb'
import type { Config } from './config.ts'
import { verifySchema } from './persistence/migrations.ts'
import { verifyRuntimePrivileges } from './persistence/roles.ts'

export interface Database {
  readonly mongo?: { client: MongoClient; db: Db }
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
  const client = factory(config.mongoUri, mongoOptions(config))
  const db = client.db(config.mongoDatabase)
  let connection: Promise<void> | undefined
  let closing: Promise<void> | undefined
  return {
    ...(client instanceof MongoClient
      ? { mongo: { client, db: client.db(config.mongoDatabase) } }
      : {}),
    connect() {
      if (closing) return Promise.reject(new Error('Database closed'))
      connection ??= client.connect().then(() => undefined)
      return connection
    },
    async check(signal) {
      if (closing) throw new Error('Database closed')
      const checkSignal = signal ?? AbortSignal.timeout(config.readinessTimeoutMs)
      await db.command(
        { ping: 1 },
        {
          timeoutMS: config.readinessTimeoutMs,
          maxTimeMS: config.readinessTimeoutMs,
          signal: checkSignal,
        },
      )
      if (client instanceof MongoClient) {
        await verifySchema(client.db(config.mongoDatabase), checkSignal)
        if (config.environment === 'production')
          await verifyRuntimePrivileges(
            client.db(config.mongoDatabase),
            checkSignal,
            config.auth !== null,
          )
      }
    },
    close() {
      closing ??= client.close()
      return closing
    },
  }
}

// Shared factory for server, migration CLI and future business services; same pool
// settings and configuration boundary, never a second connection inside a request.
export function createMongoClient(config: Config): MongoClient {
  return new MongoClient(config.mongoUri, mongoOptions(config))
}

function mongoOptions(config: Config): MongoClientOptions {
  return {
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
  }
}
