import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { startServer } from '../src/lifecycle.ts'
import { config, fakeDatabase } from './helpers.ts'
import type { FastifyInstance } from 'fastify'

function origin(app: FastifyInstance): string {
  const address = app.server.address()
  assert(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('startup checks DB before listening, shutdown closes HTTP/pool once', async (t) => {
  const database = fakeDatabase()
  const server = await startServer({ ...config(), port: 0 }, { database })
  t.after(() => server.stop())
  assert.equal(database.connects, 1)
  assert.equal(database.checks, 1)
  assert.equal(server.app.server.listening, true)
  const response = await fetch(`${origin(server.app)}/health/live`)
  assert.equal(response.status, 200)
  await response.text()
  await Promise.all([server.stop(), server.stop()])
  assert.equal(server.app.server.listening, false)
  assert.equal(database.closes, 1)
  const after = await server.app.inject('/health/live').catch(() => null)
  assert(!after || after.statusCode === 503)
})
test('database failure and occupied port both close resources and never report startup success', async () => {
  const database = fakeDatabase()
  database.available = false
  await assert.rejects(startServer({ ...config(), port: 0 }, { database }), /SERVER_START_FAILED/)
  assert.equal(database.closes, 1)
  const occupied = createServer()
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
  try {
    const address = occupied.address()
    assert(address && typeof address !== 'string')
    const second = fakeDatabase()
    await assert.rejects(
      startServer({ ...config(), port: address.port }, { database: second }),
      /SERVER_START_FAILED/,
    )
    assert.equal(second.closes, 1)
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
test('shutdown drains in-flight HTTP request before closing the database', async (t) => {
  const database = fakeDatabase()
  let started: (() => void) | undefined
  let complete: (() => void) | undefined
  const inFlight = new Promise<void>((resolve) => {
    started = resolve
  })
  const finished = new Promise<void>((resolve) => {
    complete = resolve
  })
  const server = await startServer(
    { ...config(), port: 0 },
    {
      database,
      readinessChecks: [
        async () => {
          started?.()
          await finished
        },
      ],
    },
  )
  t.after(() => server.stop())
  const request = fetch(`${origin(server.app)}/health/ready`)
  await inFlight
  const stop = server.stop()
  assert.equal(database.closes, 0)
  complete?.()
  assert.equal((await request).status, 200)
  await stop
  assert.equal(database.closes, 1)
})
