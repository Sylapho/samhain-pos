import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { sha256Hex } from '../../src/utils/integrity.ts'

// No caller-supplied URL, container, connection string or production credential.
export const origin = 'http://127.0.0.1:54321'
export const cli = process.env.SAMHAIN_SUPABASE_CLI ?? 'supabase'
export function localStatus() {
  const result = spawnSync(cli, ['status', '-o', 'json'], { encoding: 'utf8', shell: false })
  assert.equal(result.status, 0, 'Local Supabase CLI unavailable')
  const values = JSON.parse(result.stdout)
  assert.equal(values.API_URL, origin, 'Refusing a nonlocal Supabase stack')
  assert.equal(new URL(values.DB_URL).hostname, '127.0.0.1')
  return values // Never serialize this object into logs or artifacts.
}
export function sql(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        'supabase_db_samhain-pos',
        'psql',
        '-X',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      { shell: false },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.resume() // SQL errors can contain credentials/financial payloads.
    child.on('error', () => reject(new Error('Local Docker SQL unavailable')))
    child.on('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error('Local SQL fixture/assertion failed')),
    )
    child.stdin.end(input)
  })
}
export function literal(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}
export async function jsonRequest(path, key, token, body) {
  const response = await fetch(origin + path, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(40000),
    headers: {
      apikey: key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  return { status: response.status, data }
}
export async function scopeFixture() {
  const scope = { organization: randomUUID(), festival: randomUUID() }
  await sql(`insert into pos_private.organizations values('${scope.organization}',true);
    insert into pos_private.festivals values('${scope.organization}','${scope.festival}',true);`)
  return scope
}
export async function managerFixture(values, scope) {
  const email = `integration-${randomUUID()}@example.invalid`,
    password = randomUUID() + randomUUID()
  const created = await jsonRequest(
    '/auth/v1/admin/users',
    values.SERVICE_ROLE_KEY,
    values.SERVICE_ROLE_KEY,
    { email, password, email_confirm: true },
  )
  assert.equal(created.status, 200, 'Local manager fixture failed')
  const login = await jsonRequest('/auth/v1/token?grant_type=password', values.ANON_KEY, null, {
    email,
    password,
  })
  assert.equal(login.status, 200, 'Real manager login failed')
  const manager = { subject: created.data.id, token: login.data.access_token }
  await sql(`insert into pos_private.scope_grants values
    ('${scope.organization}','${scope.festival}','${manager.subject}','manage_enrollment',true),
    ('${scope.organization}','${scope.festival}','${manager.subject}','read_ledger',true);`)
  return manager
}
export async function tabletAction(values, device, action, body) {
  const challenge = await jsonRequest(
    '/functions/v1/tablet-auth-v1',
    values.ANON_KEY,
    device.token,
    { action: 'challenge', body: { installationId: device.installation } },
  )
  assert.equal(challenge.status, 200, 'Real challenge failed')
  const nonce = challenge.data.nonce,
    payload = JSON.stringify(body)
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(
      `samhain-auth/1\n${device.installation}\n${action}\n${nonce}\n${sha256Hex(payload)}`,
    ),
    device.keys.privateKey,
  ).toString('base64')
  return jsonRequest('/functions/v1/tablet-auth-v1', values.ANON_KEY, device.token, {
    action,
    payload,
    nonce,
    signature,
  })
}
export async function enroll(values, scope, manager, dossier = {}, previous) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const signup = await jsonRequest('/auth/v1/signup', values.ANON_KEY, null, {})
  assert.equal(signup.status, 200, 'Real tablet signup failed')
  const auth = signup.data
  const device = {
    ...scope,
    keys,
    chain: dossier.chainId ?? randomUUID(),
    installation: randomUUID(),
    terminal: dossier.terminalId ?? `fixture-${randomUUID()}`,
    subject: auth.user.id,
    token: auth.access_token,
    refresh: auth.refresh_token,
    session: JSON.parse(Buffer.from(auth.access_token.split('.')[1], 'base64url').toString())
      .session_id,
  }
  const request = await jsonRequest('/functions/v1/tablet-auth-v1', values.ANON_KEY, device.token, {
    action: 'request',
    body: {
      chainId: device.chain,
      terminalId: device.terminal,
      restored: false,
      prefix: [],
      legacyOrderIds: [],
      ...dossier,
      installationId: device.installation,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
  })
  assert.equal(request.status, 200, 'Real enrollment request failed')
  const approved = await jsonRequest(
    '/functions/v1/tablet-auth-v1',
    values.ANON_KEY,
    manager.token,
    {
      action: 'approve',
      body: {
        requestId: request.data.requestId,
        organizationId: scope.organization,
        festivalId: scope.festival,
        chainId: device.chain,
        ...(previous ? { replacesInstallationId: previous.installation } : {}),
      },
    },
  )
  assert.equal(approved.status, 200, 'Real scoped enrollment approval failed')
  const activated = await tabletAction(values, device, 'activate', {
    installationId: device.installation,
    invitationCode: approved.data.invitationCode,
  })
  assert.equal(activated.status, 200, 'Real signed enrollment activation failed')
  assert.ok(
    ['authorized', 'needs_recovery'].includes(activated.data.status),
    'Enrollment was not activated',
  )
  device.authorization = activated.data
  return device
}
export async function sendDevice(values, device, endpoint, raw) {
  const challenge = await jsonRequest(
    '/functions/v1/tablet-auth-v1',
    values.ANON_KEY,
    device.token,
    { action: 'challenge', body: { installationId: device.installation } },
  )
  assert.equal(challenge.status, 200, 'Real sync challenge failed')
  const nonce = challenge.data.nonce
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`samhain-auth/1\n${device.installation}\n${endpoint}\n${nonce}\n${sha256Hex(raw)}`),
    device.keys.privateKey,
  ).toString('base64')
  const response = await fetch(`${origin}/functions/v1/${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(40000),
    headers: {
      apikey: values.ANON_KEY,
      Authorization: `Bearer ${device.token}`,
      'Content-Type': 'application/json',
      'X-Samhain-Nonce': nonce,
      'X-Samhain-Signature': signature,
    },
    body: raw,
  })
  return { status: response.status, data: await response.json() }
}
