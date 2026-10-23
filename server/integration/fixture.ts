import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { Db } from 'mongodb'
import { migrate } from '../src/persistence/migrations.ts'
import { createPersistence } from '../src/persistence/store.ts'
import type { TabletContext } from '../src/persistence/store.ts'
import { fingerprint, sha256 } from '../src/persistence/proofs.ts'
import type { LedgerProof } from '../src/persistence/proofs.ts'
import { stable } from '../src/persistence/migrations.ts'

export function testTarget() {
  const uri = process.env.MONGODB_TEST_URI
  const name = process.env.MONGODB_TEST_DATABASE
  if (
    !uri ||
    !/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):27019\/(?:\?.*)?$/.test(uri) ||
    !name ||
    !/^samhain_test_[a-z0-9_]{1,35}$/.test(name) ||
    process.env.MONGODB_TEST_DISPOSABLE !== 'true'
  )
    throw new Error(
      'Disposable test target required: loopback:27019, samhain_test_ namespace, explicit opt-in',
    )
  return { uri, name }
}
const publicKeySpki = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64')

export async function fixture(initialize = true) {
  const target = testTarget()
  const client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 2000, timeoutMS: 3000 })
  await client.connect()
  const db = client.db(`${target.name}_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
  try {
    if (initialize) await migrate(db)
  } catch (error) {
    await client.close()
    throw error
  }
  return { client, db, store: createPersistence(client, db) }
}

export async function seed(
  db: Db,
  existingScope?: { organizationId: string; festivalId: string },
): Promise<TabletContext> {
  const context: TabletContext = {
    organizationId: existingScope?.organizationId ?? randomUUID(),
    festivalId: existingScope?.festivalId ?? randomUUID(),
    chainId: randomUUID(),
    installationId: randomUUID(),
    enrollmentGeneration: 1,
    issuer: 'test-api',
    subject: randomUUID(),
    sessionId: randomUUID(),
    keyFingerprint: sha256(publicKeySpki),
    nonceHash: sha256(randomUUID()),
    requestId: randomUUID(),
  }
  const scope = { organizationId: context.organizationId, festivalId: context.festivalId }
  const chain = { ...scope, chainId: context.chainId }
  if (!existingScope) {
    await db.collection('organizations').insertOne({
      documentSchemaVersion: 1,
      organizationId: context.organizationId,
      active: true,
      fence: 0,
    })
    await db
      .collection('festivals')
      .insertOne({ documentSchemaVersion: 1, ...scope, active: true, fence: 0 })
  }
  await db.collection('chains').insertOne({
    documentSchemaVersion: 1,
    ...chain,
    enrollmentGeneration: 1,
    head: { sequence: 0, hash: null },
    fence: 0,
  })
  const identity = {
    ...chain,
    installationId: context.installationId,
    enrollmentGeneration: 1,
    issuer: context.issuer,
    subject: context.subject,
  }
  await db.collection('installations').insertOne({
    documentSchemaVersion: 1,
    ...identity,
    active: true,
    authorization: 'authorized',
    fence: 0,
  })
  await db.collection('installationKeys').insertOne({
    documentSchemaVersion: 1,
    installationId: context.installationId,
    enrollmentGeneration: 1,
    publicKeySpki,
    keyFingerprint: context.keyFingerprint,
    createdAt: new Date(),
  })
  await db.collection('apiSessions').insertOne({
    documentSchemaVersion: 1,
    ...identity,
    sessionId: context.sessionId,
    refreshHash: sha256(randomUUID()),
    familyId: randomUUID(),
    active: true,
    expiresAt: new Date(Date.now() + 600000),
    absoluteExpiresAt: new Date(Date.now() + 600000),
    fence: 0,
  })
  await db.collection('terminalRanges').insertOne({
    documentSchemaVersion: 1,
    ...chain,
    firstSequence: 1,
    lastSequence: null,
    sourceTerminalId: 'test-terminal',
    evidenceReference: 'isolated-fixture',
  })
  await challenge(db, context)
  return context
}
export async function challenge(
  db: Db,
  context: TabletContext,
  action = 'ledger-ingest-v1',
  expiresAt = new Date(Date.now() + 60000),
) {
  context.nonceHash = sha256(randomUUID())
  context.requestId = randomUUID()
  const {
    organizationId,
    festivalId,
    chainId,
    installationId,
    enrollmentGeneration,
    issuer,
    subject,
    sessionId,
    keyFingerprint,
    nonceHash,
  } = context
  await db.collection('authChallenges').insertOne({
    documentSchemaVersion: 1,
    purpose: 'session',
    organizationId,
    festivalId,
    chainId,
    installationId,
    enrollmentGeneration,
    issuer,
    subject,
    sessionId,
    keyFingerprint,
    nonceHash,
    action,
    expiresAt,
    consumedAt: null,
  })
}
export function event(
  context: TabletContext,
  sequence = 1,
  previousHash: string | null = null,
  changes: Record<string, unknown> = {},
  profile: 'ts-ledger-v1' | 'android-ledger-v1' = 'ts-ledger-v1',
): LedgerProof {
  const unsigned = {
    id: `sale:${randomUUID()}`,
    schemaVersion: 1,
    kind: 'sale',
    sequence,
    recordedAt: '2026-10-24T00:00:00Z',
    previousHash,
    source: {
      terminal: { terminalId: 'test-terminal' },
      softwareVersion: 'test',
      buildMode: 'test',
      organization: {},
    },
    orderId: randomUUID(),
    ...changes,
  }
  // Test-only minimal snapshots: these exercise the data layer, not #133's monetary validator.
  const body = {
    ...unsigned,
    ...(unsigned.kind === 'sale' ? { order: { id: unsigned.orderId } } : {}),
  }
  const canon = (value: unknown) =>
    profile === 'android-ledger-v1' ? stable(value).replaceAll('/', '\\/') : stable(value)
  const hash = sha256(canon(body))
  const proof = {
    eventId: body.id,
    sequence,
    previousHash,
    hash,
    sourceTerminalId: 'test-terminal',
    ledgerCanonicalization: profile,
    payloadCanonical: canon({ ...body, hash }),
    transportFingerprint: '',
  }
  proof.transportFingerprint = fingerprint(
    {
      organizationId: context.organizationId,
      festivalId: context.festivalId,
      chainId: context.chainId,
    },
    proof,
  )
  return proof
}
export const validatedForStorage = async () => {
  /* Full protocol business rules are tested in #133. */
}
