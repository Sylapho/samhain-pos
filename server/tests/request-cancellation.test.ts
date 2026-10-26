import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { buildApp } from '../src/app.ts'
import { config, fakeDatabase, policy, principal } from './helpers.ts'
import { runTransaction } from '../src/persistence/transactions.ts'

test('real completed POST body does not cancel the financial transaction before work starts', async (t) => {
  let writes = 0
  const app = await buildApp(config(), {
    database: fakeDatabase(),
    authenticate: async () => principal,
    apiRoutes: async (api) => {
      api.post('/probe', { config: { access: policy } }, async (request) => {
        await setImmediate()
        assert.equal(request.raw.complete, true)
        assert.equal(request.raw.destroyed, true)
        assert.equal(request.operationSignal.aborted, false)
        return runTransaction(
          () => ({
            startTransaction() {},
            async commitTransaction() {},
            async abortTransaction() {},
            inTransaction: () => true,
            async endSession() {},
          }),
          async () => {
            writes++
            return { completed: true }
          },
          { signal: request.operationSignal },
        )
      })
    },
  })
  t.after(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const response = await fetch(address + '/api/v1/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { completed: true })
  assert.equal(writes, 1)
})

test('real client disconnect cancels unfinished HTTP work', async (t) => {
  let entered!: () => void
  let cancelled!: () => void
  const handlerEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const workCancelled = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const app = await buildApp(config(), {
    database: fakeDatabase(),
    authenticate: async () => principal,
    apiRoutes: async (api) => {
      api.post('/probe', { config: { access: policy } }, async (request) => {
        request.operationSignal.addEventListener('abort', cancelled, { once: true })
        entered()
        await workCancelled
        return { completed: false }
      })
    },
  })
  t.after(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = httpRequest(address + '/api/v1/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  client.on('error', () => {})
  t.after(() => client.destroy())
  client.end('{}')
  await handlerEntered
  client.destroy()
  await workCancelled
})

test('completed POST body does not disable the bounded HTTP handler deadline', async (t) => {
  let signal: AbortSignal | undefined
  const app = await buildApp(
    { ...config(), requestTimeoutMs: 150 },
    {
      database: fakeDatabase(),
      authenticate: async () => principal,
      apiRoutes: async (api) => {
        api.post('/probe', { config: { access: policy } }, async (request) => {
          signal = request.operationSignal
          await new Promise<void>((resolve) =>
            signal!.addEventListener('abort', () => resolve(), { once: true }),
          )
          // The deadline owns the error response, rather than sending a late success.
        })
      },
    },
  )
  t.after(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const response = await fetch(address + '/api/v1/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 503)
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await response.json(), { error: { code: 'SERVER_UNAVAILABLE' } })
})
