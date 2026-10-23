import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MongoClientOptions } from 'mongodb'
import { createDatabase } from '../src/database.ts'
import { config } from './helpers.ts'

test('one shared client, bounded options, configured namespace, fresh probes and idempotent close', async () => {
  let clients = 0
  let connects = 0
  let closes = 0
  let pings = 0
  let options: MongoClientOptions = {}
  let selectedDatabase = ''
  const database = createDatabase(config(), (_uri, providedOptions) => {
    clients++
    options = providedOptions
    return {
      connect: async () => {
        connects++
      },
      close: async () => {
        closes++
      },
      db: (name) => {
        selectedDatabase = name
        return {
          databaseName: name,
          command: async (command, commandOptions) => {
            assert.deepEqual(command, { ping: 1 })
            assert.equal(commandOptions.timeoutMS, 2000)
            pings++
          },
        }
      },
    }
  })
  await Promise.all([database.connect(), database.connect()])
  await database.check()
  await database.check()
  await Promise.all([database.close(), database.close()])
  assert.deepEqual(
    { clients, connects, closes, pings, selectedDatabase },
    { clients: 1, connects: 1, closes: 1, pings: 2, selectedDatabase: 'samhain_test_unit' },
  )
  assert.equal(options.maxPoolSize, 10)
  assert.equal(options.minPoolSize, 0)
  for (const key of [
    'connectTimeoutMS',
    'serverSelectionTimeoutMS',
    'socketTimeoutMS',
    'timeoutMS',
    'waitQueueTimeoutMS',
  ] as const)
    assert(Number(options[key]) > 0)
  await assert.rejects(database.connect(), /closed/)
  await assert.rejects(database.check(), /closed/)
})

test('unreachable localhost database has bounded connection failure and closes its pool', async () => {
  const database = createDatabase({
    ...config(),
    mongoUri: 'mongodb://127.0.0.1:1/',
    connectTimeoutMs: 100,
    selectionTimeoutMs: 150,
    operationTimeoutMs: 200,
  })
  const started = performance.now()
  try {
    await assert.rejects(database.connect())
    assert(performance.now() - started < 2500)
  } finally {
    await database.close()
  }
})
