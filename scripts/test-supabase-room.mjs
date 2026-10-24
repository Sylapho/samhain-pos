import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  enroll,
  jsonRequest,
  literal,
  localStatus,
  managerFixture,
  scopeFixture,
  sendDevice,
  sql,
} from './lib/supabase-local.mjs'

// Test-only bridge: Room/SyncEngine supply the exact request bytes. Node simulates
// the installation signer (not Android Keystore), using real Auth, Edge and SQL.
const values = localStatus()
const allAndroid = process.argv.includes('--all-android')
if (process.argv.slice(2).some((arg) => arg !== '--all-android'))
  throw new Error('Unknown argument')
const scopes = await Promise.all([scopeFixture(), scopeFixture()])
const managers = await Promise.all(scopes.map((scope) => managerFixture(values, scope)))
const devices = new Map()
const evidence = []
const secret = randomUUID()
let enrolled = 0,
  sends = 0,
  committedLosses = 0,
  verified = 0
const server = createServer(async (request, response) => {
  let action = 'parse'
  try {
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    assert.equal(request.method, 'POST')
    let raw = ''
    for await (const chunk of request) {
      raw += chunk
      assert.ok(Buffer.byteLength(raw) <= 2097152)
    }
    const command = JSON.parse(raw)
    action = command.action
    let result
    if (command.action === 'enroll') {
      assert.ok(enrolled < 2)
      const device = await enroll(values, scopes[enrolled], managers[enrolled], command.dossier)
      assert.equal(device.authorization.status, 'authorized')
      devices.set(device.chain, device)
      enrolled++
      result = device.authorization
    } else {
      const device = devices.get(command.chainId)
      assert.ok(device, 'Unknown local test chain')
      if (command.action === 'send') {
        assert.ok(
          ['ledger-ingest-v1', 'legacy-import-v1', 'ledger-prefix-v1'].includes(command.endpoint),
        )
        const sent = JSON.parse(command.raw)
        assert.equal(sent.chainId, device.chain)
        result = await sendDevice(values, device, command.endpoint, command.raw)
        sends++
        if (command.loseAck) {
          assert.equal(
            result.status,
            200,
            `Commit prerequisite HTTP ${result.status}/${result.data.error?.code ?? 'NO_CODE'}`,
          )
          assert.equal(result.data.committed, true)
          committedLosses++
          result = { status: 408, data: { error: { code: 'NETWORK_ERROR' } } }
        }
      } else if (command.action === 'revoke') {
        result = await jsonRequest(
          '/functions/v1/tablet-auth-v1',
          values.ANON_KEY,
          managers[scopes.findIndex((scope) => scope.organization === device.organization)].token,
          {
            action: 'revoke',
            body: { chainId: device.chain, installationId: device.installation },
          },
        )
        assert.equal(result.status, 200, 'Real manager revocation failed')
      } else if (command.action === 'verify') {
        const stored = JSON.parse(
          await sql(`select coalesce(jsonb_agg(jsonb_build_object(
          'eventId',e.event_id,'sequence',e.sequence,'hash',e.hash,'previousHash',e.previous_hash,
          'payloadCanonical',e.payload_canonical,'transportFingerprint',e.transport_fingerprint,
          'receiptId',r.receipt_id,'serverReceivedAt',to_char(r.server_received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by e.sequence),'[]')
          from pos_private.ledger_events e join pos_private.sync_receipts r
          using(organization_id,festival_id,chain_id,event_id) where e.chain_id=${literal(device.chain)};`),
        )
        // Compare original bytes and individual ACKs, not aggregate revenue.
        assert.deepEqual(stored, command.events, 'Room/server tuples or receipts differ')
        const head = JSON.parse(
          await sql(`select jsonb_build_object('sequence',head_sequence,'hash',head_hash)
          from pos_private.chains where chain_id=${literal(device.chain)};`),
        )
        assert.deepEqual(head, { sequence: stored.length, hash: stored.at(-1)?.hash ?? null })
        assert.equal(command.localSnapshotHashBefore, command.localSnapshotHashAfter)
        evidence.push({
          chainId: device.chain,
          environment: 'synthetic local fixtures only',
          eventsBefore: command.events.length,
          eventsAfter: stored.length,
          serverHead: head,
          localSnapshotHashBefore: command.localSnapshotHashBefore,
          localSnapshotHashAfter: command.localSnapshotHashAfter,
          tuples: stored.map(({ payloadCanonical: omitted, ...tuple }) => {
            void omitted
            return tuple
          }),
        })
        verified++
        result = { verified: true, events: stored.length }
      } else throw new Error('Unsupported bridge operation')
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result))
  } catch (error) {
    console.error(`Local bridge ${action}: ${String(error.message).split('\n')[0]}`)
    // Never return Auth errors, dossiers, SQL text or secrets in Gradle reports.
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end('{"error":"LOCAL_INTEGRATION_ASSERTION_FAILED"}')
  }
})
server.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
try {
  const bridgeUrl = `http://127.0.0.1:${server.address().port}`
  const args = [
    '-p',
    'android',
    'testDebugUnitTest',
    ...(!allAndroid ? ['--tests', 'fr.samhain.pos.LiveSupabaseIntegrationTest'] : []),
    '--rerun',
    ...(allAndroid ? ['assembleDebug'] : []),
    '--no-daemon',
    '--console=plain',
  ]
  const isWindows = process.platform === 'win32'
  const child = spawn(
    isWindows ? 'cmd.exe' : './android/gradlew',
    isWindows ? ['/d', '/s', '/c', 'android\\gradlew.bat', ...args] : args,
    {
      shell: false,
      stdio: 'inherit',
      env: {
        ...process.env,
        SAMHAIN_INTEGRATION_BRIDGE: bridgeUrl,
        SAMHAIN_INTEGRATION_NONCE: secret,
      },
    },
  )
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, 'Live Room integration Gradle failed')
  const report = readFileSync(
    'android/app/build/test-results/testDebugUnitTest/TEST-fr.samhain.pos.LiveSupabaseIntegrationTest.xml',
    'utf8',
  )
  assert.match(report, /tests="2"/)
  assert.match(report, /skipped="1"/)
  assert.equal(enrolled, 2, 'Both independent scopes must execute')
  assert.ok(
    sends >= 6 && committedLosses === 2 && verified === 2,
    'Integration did not execute required phases',
  )
  console.log(
    'PASS: two real Room chains/scopes; offline commits, lost ACK after SQL commit, disk restart, exact tuples/receipts, revocation and unchanged printing.',
  )
} finally {
  mkdirSync('reports', { recursive: true })
  writeFileSync(
    'reports/supabase-room.json',
    JSON.stringify(
      { date: new Date().toISOString(), enrolled, sends, committedLosses, verified, evidence },
      null,
      2,
    ) + '\n',
  )
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
