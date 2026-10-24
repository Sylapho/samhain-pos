import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { authFixture, candidate } from '../server/integration/auth-fixture.ts'
import { testTarget } from '../server/integration/fixture.ts'

// Reuse the existing Room campaign and server fixtures. Only explicitly disposable,
// loopback MongoDB is accepted. This bridge simulates the signer, never Android TLS/Keystore.
testTarget()
const fixture = await authFixture()
const devices = new Map()
const secret = randomUUID()
const evidence = []
let sends = 0
let lostAcks = 0
let verified = 0
const bridge = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 2097152)
      chunks.push(chunk)
    }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    let result
    if (command.action === 'enroll') {
      assert.ok(devices.size < 2)
      const dossier = command.dossier
      const scope = await fixture.scope()
      const tablet = candidate(fixture, dossier.chainId, dossier)
      const enrolled = await tablet.enroll(scope)
      devices.set(tablet.chainId, { tablet, scope, enrolled })
      result = {
        status: 'authorized',
        ...scope,
        chainId: tablet.chainId,
        installationId: tablet.installationId,
        enrollmentGeneration: enrolled.enrollmentGeneration,
        destinationId: fixture.configuration.destinationId,
      }
    } else {
      const device = devices.get(command.chainId)
      assert.ok(device, 'Unknown test chain')
      const { tablet, scope, enrolled } = device
      if (command.action === 'send') {
        if (device.revoked) {
          const denied = await fixture.app.inject({
            method: 'POST',
            url: '/api/v1/auth/challenges',
            payload: {
              installationId: tablet.installationId,
              publicKey: tablet.publicKey,
              action: command.endpoint,
            },
          })
          assert.equal(denied.statusCode, 403)
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ status: denied.statusCode, data: denied.json() }))
          return
        }
        const endpoint = {
          'ledger-ingest-v1': 'ingest',
          'legacy-import-v1': 'legacy',
          'ledger-prefix-v1': 'prefix',
        }[command.endpoint]
        assert.ok(endpoint)
        const reply = await tablet.signed(
          `/api/v1/ledger/${endpoint}`,
          command.endpoint,
          JSON.parse(command.raw),
          enrolled.session.access_token,
        )
        sends++
        result = { status: reply.statusCode, data: reply.json() }
        if (command.loseAck) {
          assert.equal(reply.statusCode, 200, reply.body)
          assert.equal(reply.json().committed, true)
          lostAcks++
          result = { status: 408, data: { error: { code: 'NETWORK_ERROR' } } }
        }
      } else if (command.action === 'verify') {
        const chainScope = { ...scope, chainId: tablet.chainId }
        const stored = await fixture.db
          .collection('ledgerEvents')
          .find(chainScope)
          .sort({ sequence: 1 })
          .toArray()
        const receipts = await fixture.db.collection('syncReceipts').find(chainScope).toArray()
        assert.equal(stored.length, command.events.length)
        assert.equal(receipts.length, stored.length)
        for (const local of command.events) {
          const remote = stored.find((entry) => entry.eventId === local.eventId)
          const receipt = receipts.find((entry) => entry.eventId === local.eventId)
          assert.ok(remote && receipt)
          for (const field of [
            'eventId',
            'sequence',
            'hash',
            'previousHash',
            'payloadCanonical',
            'transportFingerprint',
          ])
            assert.equal(remote[field], local[field], `Immutable tuple mismatch: ${field}`)
          assert.equal(receipt.receiptId, local.receiptId)
          assert.equal(receipt.serverReceivedAt.toISOString(), local.serverReceivedAt)
        }
        const chain = await fixture.db.collection('chains').findOne(chainScope)
        assert.deepEqual(chain.head, { sequence: stored.length, hash: stored.at(-1).hash })
        assert.equal(command.localSnapshotHashBefore, command.localSnapshotHashAfter)
        evidence.push({
          chainId: tablet.chainId,
          events: stored.length,
          unchangedFinancialSnapshot: true,
        })
        verified++
        result = { verified: true }
      } else if (command.action === 'revoke') {
        const reply = await fixture.app.inject({
          method: 'POST',
          url: `/api/v1/tablets/${tablet.installationId}/revoke`,
          headers: { authorization: `Bearer ${fixture.manager}` },
          payload: { ...scope, chainId: tablet.chainId, operationRequestId: randomUUID() },
        })
        assert.equal(reply.statusCode, 200, reply.body)
        device.revoked = true
        result = { revoked: true }
      } else throw new Error('Unknown local bridge operation')
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result))
  } catch (error) {
    console.error(`MongoDB Room campaign: ${String(error.message).split('\n')[0]}`)
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end('{"error":"LOCAL_INTEGRATION_ASSERTION_FAILED"}')
  }
})
try {
  bridge.listen(0, '127.0.0.1')
  await new Promise((resolve) => bridge.once('listening', resolve))
  const args = [
    '-p',
    'android',
    'testDebugUnitTest',
    '--tests',
    'fr.samhain.pos.LiveSupabaseIntegrationTest.roomV9SupabaseReceiptsMigrateToRealMongoAndResumeWithoutReplayingBusiness',
    '--rerun',
    '--console=plain',
  ]
  const windows = process.platform === 'win32'
  const child = spawn(
    windows ? 'cmd.exe' : './android/gradlew',
    windows ? ['/d', '/s', '/c', 'android\\gradlew.bat', ...args] : args,
    {
      shell: false,
      stdio: 'inherit',
      env: {
        ...process.env,
        SAMHAIN_MONGODB_BRIDGE: `http://127.0.0.1:${bridge.address().port}`,
        SAMHAIN_MONGODB_NONCE: secret,
      },
    },
  )
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, 'Room MongoDB Gradle campaign failed')
  const report = readFileSync(
    'android/app/build/test-results/testDebugUnitTest/TEST-fr.samhain.pos.LiveSupabaseIntegrationTest.xml',
    'utf8',
  )
  assert.match(report, /tests="1"/)
  assert.match(report, /skipped="0"/)
  assert.equal(devices.size, 2)
  assert.equal(lostAcks, 2)
  assert.equal(verified, 2)
  assert.equal(sends, 10) // Five batches per chain: one lost response, its replay, three successors.
  console.log(
    'PASS: v9 Room migration, two scopes, retained Supabase receipts, MongoDB transactions, lost ACK, disk restart, exact tuples, revocation and unchanged payments/printing.',
  )
} finally {
  mkdirSync('reports', { recursive: true })
  writeFileSync(
    'reports/mongodb-room.json',
    JSON.stringify(
      { date: new Date().toISOString(), sends, lostAcks, verified, evidence },
      null,
      2,
    ) + '\n',
  )
  bridge.closeAllConnections()
  await new Promise((resolve) => bridge.close(resolve))
  await fixture.close()
}
