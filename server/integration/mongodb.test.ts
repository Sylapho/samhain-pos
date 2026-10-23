import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MongoClient } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { createDatabase } from '../src/database.ts'
import { startServer } from '../src/lifecycle.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, connect } from 'node:net'
import type { Socket } from 'node:net'
import { migrate } from '../src/persistence/migrations.ts'

const uri = process.env.MONGODB_TEST_URI
const name = process.env.MONGODB_TEST_DATABASE
// Deliberately ignores MONGODB_URI/MONGODB_DATABASE. No write/drop/cleanup of any database.
function testConfig() {
  if (!uri || !name || process.env.MONGODB_TEST_DISPOSABLE !== 'true')
    throw new Error(
      'Integration requires MONGODB_TEST_URI, MONGODB_TEST_DATABASE and MONGODB_TEST_DISPOSABLE=true',
    )
  if (!/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):27019\/(?:\?.*)?$/.test(uri))
    throw new Error(
      'Integration URI must target the disposable loopback fixture on port 27019 without credentials',
    )
  return loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MONGODB_DATABASE: name,
    MONGODB_TLS: 'false',
    LOG_LEVEL: 'silent',
    MONGODB_SELECTION_TIMEOUT_MS: '500',
    READINESS_TIMEOUT_MS: '500',
  })
}

test(
  'explicitly disposable MongoDB: real connection, database, replica set and read-only health',
  { skip: !uri ? 'MongoDB integration not executed: MONGODB_TEST_URI absent' : false },
  async (t) => {
    const config = testConfig()
    const observer = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 1000 })
    t.after(() => observer.close())
    await observer.connect() // configured but unavailable MUST fail, never silently skip
    const db = observer.db(config.mongoDatabase)
    assert.equal(db.databaseName, name)
    const hello = await db.command({ hello: 1 })
    assert.equal(hello.setName, 'samhain-test')
    assert.equal(hello.isWritablePrimary, true)
    await migrate(db)
    const before = await db.listCollections({}, { nameOnly: true }).toArray()
    const database = createDatabase(config)
    const server = await startServer({ ...config, port: 0 }, { database })
    t.after(() => server.stop())
    assert.equal((await server.app.inject('/health/live')).statusCode, 200)
    for (let i = 0; i < 3; i++)
      assert.equal((await server.app.inject('/health/ready')).statusCode, 200)
    const after = await db.listCollections({}, { nameOnly: true }).toArray()
    assert.deepEqual(after, before, 'health/startup must never create collections')
    await server.stop()
    await assert.rejects(database.check(), /closed/)
  },
)

test(
  'real database outage changes readiness to 503 while liveness survives',
  { skip: !uri ? 'MongoDB integration not executed: MONGODB_TEST_URI absent' : false },
  async (t) => {
    const config = testConfig()
    const initializer = new MongoClient(config.mongoUri, { timeoutMS: 3000 })
    try {
      await migrate(initializer.db(config.mongoDatabase))
    } finally {
      await initializer.close()
    }
    // Local TCP relay simulates network loss without stopping/changing the shared fixture.
    const sockets = new Set<Socket>()
    const relay = createServer((incoming) => {
      const upstream = connect(27019, '127.0.0.1')
      for (const socket of [incoming, upstream]) {
        sockets.add(socket)
        socket.on('error', () => {
          incoming.destroy()
          upstream.destroy()
        })
        socket.on('close', () => sockets.delete(socket))
      }
      incoming.pipe(upstream).pipe(incoming)
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      for (const socket of sockets) socket.destroy()
      relay.close()
    })
    const address = relay.address()
    assert(address && typeof address !== 'string')
    const database = createDatabase({
      ...config,
      mongoUri: `mongodb://127.0.0.1:${address.port}/?directConnection=true`,
    })
    const server = await startServer({ ...config, port: 0 }, { database })
    t.after(() => server.stop())
    assert.equal((await server.app.inject('/health/ready')).statusCode, 200)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve())),
    )
    const unavailable = await server.app.inject('/health/ready')
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), { status: 'unavailable' })
    assert.equal((await server.app.inject('/health/live')).statusCode, 200)
  },
)

test(
  'compiled process handles SIGTERM/SIGINT and exits without remaining resources',
  {
    skip:
      !uri || process.platform === 'win32'
        ? 'Requires MongoDB and Linux CI; Windows does not deliver graceful SIGTERM/SIGINT to child processes'
        : false,
  },
  async () => {
    const config = testConfig()
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const port = 31000 + Math.floor(Math.random() * 10000)
      const child = spawn(process.execPath, ['dist/index.js'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MONGODB_URI: config.mongoUri,
          MONGODB_DATABASE: config.mongoDatabase,
          MONGODB_TLS: 'false',
          HOST: '127.0.0.1',
          PORT: String(port),
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      try {
        const exited = once(child, 'exit')
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Process did not start')), 10000)
          child.stdout.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('"event":"started"')) {
              clearTimeout(timer)
              resolve()
            }
          })
          child.once('exit', () => {
            clearTimeout(timer)
            reject(new Error('Process exited before ready'))
          })
        })
        child.kill(signal)
        const result = await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Shutdown deadline exceeded')), 15000)
            timer.unref()
          }),
        ])
        assert.equal(result[0], 0)
        assert.equal(result[1], null)
      } finally {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      }
    }
  },
)

test('production names are refused by integration guard even with explicit opt-in', () => {
  const previous = process.env.MONGODB_TEST_DATABASE
  process.env.MONGODB_TEST_DATABASE = `production_${randomUUID()}`
  // loadConfig itself is independently guarded; no driver connection or cleanup is attempted.
  assert.throws(() =>
    loadConfig({
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27019/',
      MONGODB_TLS: 'false',
      MONGODB_DATABASE: process.env.MONGODB_TEST_DATABASE,
    }),
  )
  if (previous === undefined) delete process.env.MONGODB_TEST_DATABASE
  else process.env.MONGODB_TEST_DATABASE = previous
})
