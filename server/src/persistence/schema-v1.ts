import type { Document, IndexDescription } from 'mongodb'
import type { Documents } from './model.ts'

const id = { bsonType: 'string', minLength: 1, maxLength: 512, pattern: '\\S' }
const uuid = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}
const hash = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' }
const nullableHash = { anyOf: [hash, { bsonType: 'null' }] }
const date = { bsonType: 'date' }
const bool = { bsonType: 'bool' }
const literal = (value: unknown): Document => ({ enum: [value] })
const integer = (minimum = 0): Document => ({
  bsonType: ['int', 'long', 'double', 'decimal'],
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
})
const payload = { bsonType: 'string', minLength: 1, maxLength: 262144 }
const subject = { issuer: id, subject: id }
const scope = { organizationId: uuid, festivalId: uuid }
const chain = { ...scope, chainId: uuid }
const json = (
  properties: Document,
  required = Object.keys(properties),
  extra: Document = {},
): Document => ({
  bsonType: 'object',
  additionalProperties: false,
  properties: { _id: {}, documentSchemaVersion: literal(1), ...properties },
  required: ['documentSchemaVersion', ...required],
  ...extra,
})
const embedded = (properties: Document): Document => ({
  bsonType: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
})
const head = {
  ...embedded({ sequence: integer(), hash: nullableHash }),
  oneOf: [
    { properties: { sequence: literal(0), hash: literal(null) } },
    { properties: { sequence: integer(1), hash } },
  ],
}
const ledgerProperties = {
  ...chain,
  eventId: id,
  kind: { enum: ['sale', 'correction', 'closure', 'cash_session_opened', 'cash_float_updated'] },
  sequence: integer(1),
  hash,
  previousHash: nullableHash,
  ledgerSchemaVersion: literal(1),
  protocolVersion: literal(1),
  ledgerCanonicalization: { enum: ['ts-ledger-v1', 'android-ledger-v1'] },
  payloadCanonical: payload,
  transportFingerprint: hash,
  sourceTerminalId: id,
  recordedAt: {
    bsonType: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$',
  },
  serverReceivedAt: date,
}
const receiptProperties = {
  ...chain,
  eventType: { enum: ['ledger', 'legacy_order'] },
  eventId: id,
  receiptId: uuid,
  serverReceivedAt: date,
  sequence: { anyOf: [integer(1), { bsonType: 'null' }] },
  hash: nullableHash,
  transportFingerprint: hash,
  installationId: uuid,
  enrollmentGeneration: integer(1),
  ...subject,
  firstRequestId: uuid,
}
const validators: Record<keyof Documents, Document> = {
  organizations: json({ organizationId: uuid, active: bool, fence: integer() }),
  festivals: json({ ...scope, active: bool, fence: integer() }),
  scopeGrants: json({
    ...scope,
    ...subject,
    capability: { enum: ['manage_enrollment', 'read_ledger', 'publish_catalog'] },
    active: bool,
    fence: integer(),
  }),
  authorizationGuards: json({ guardId: id, fence: integer() }),
  chains: json({ ...chain, enrollmentGeneration: integer(1), head, fence: integer() }),
  installations: json({
    ...chain,
    ...subject,
    installationId: uuid,
    enrollmentGeneration: integer(1),
    active: bool,
    authorization: { enum: ['authorized', 'needs_recovery', 'revoked'] },
    fence: integer(),
  }),
  installationKeys: json({
    installationId: uuid,
    enrollmentGeneration: integer(1),
    publicKeySpki: {
      bsonType: 'string',
      minLength: 300,
      maxLength: 2000,
      pattern: '^[A-Za-z0-9+/=]+$',
    },
    keyFingerprint: hash,
    createdAt: date,
  }),
  enrollmentRequests: json(
    {
      requestId: uuid,
      installationId: uuid,
      publicKeySpki: {
        bsonType: 'string',
        minLength: 300,
        maxLength: 2000,
        pattern: '^[A-Za-z0-9+/=]+$',
      },
      dossierCanonical: { ...payload, maxLength: 1048576 },
      status: { enum: ['pending', 'approved', 'rejected', 'activated'] },
      expiresAt: date,
      createdAt: date,
      approvedScope: {
        bsonType: 'object',
        additionalProperties: false,
        properties: { ...chain, replacesInstallationId: uuid },
        required: Object.keys(chain),
      },
      approvedBy: embedded(subject),
      approvedAt: date,
      invitationHash: hash,
      invitationExpiresAt: date,
      attempts: { ...integer(), maximum: 5 },
    },
    [
      'requestId',
      'installationId',
      'publicKeySpki',
      'dossierCanonical',
      'status',
      'expiresAt',
      'createdAt',
      'attempts',
    ],
  ),
  terminalRanges: json({
    ...chain,
    firstSequence: integer(1),
    lastSequence: { anyOf: [integer(1), { bsonType: 'null' }] },
    sourceTerminalId: id,
    evidenceReference: id,
  }),
  ledgerEvents: json(
    {
      ...ledgerProperties,
      orderId: id,
      operationId: id,
      sessionId: id,
      referencedSessionId: id,
      originalOrderId: id,
      originalSaleHash: nullableHash,
    },
    Object.keys(ledgerProperties),
    {
      allOf: [
        {
          oneOf: [
            { properties: { sequence: literal(1), previousHash: literal(null) } },
            { properties: { sequence: integer(2), previousHash: hash } },
          ],
        },
        {
          oneOf: [
            { properties: { kind: literal('sale') }, required: ['orderId'] },
            {
              properties: { kind: literal('correction') },
              required: ['operationId', 'originalOrderId', 'originalSaleHash'],
            },
            { properties: { kind: literal('closure') }, required: ['operationId'] },
            { properties: { kind: literal('cash_session_opened') }, required: ['sessionId'] },
            {
              properties: { kind: literal('cash_float_updated') },
              required: ['operationId', 'referencedSessionId'],
            },
          ],
        },
      ],
    },
  ),
  sales: json(
    {
      ...chain,
      orderId: id,
      type: { enum: ['sealed', 'legacy'] },
      ledgerEventId: id,
      saleHash: hash,
      payloadCanonical: payload,
      transportFingerprint: hash,
      protocolVersion: literal(1),
      sourceTerminalId: id,
    },
    [...Object.keys(chain), 'orderId', 'type'],
    {
      oneOf: [
        {
          properties: { type: literal('sealed') },
          required: ['ledgerEventId', 'saleHash'],
          not: {
            anyOf: [
              'payloadCanonical',
              'transportFingerprint',
              'protocolVersion',
              'sourceTerminalId',
            ].map((field) => ({ required: [field] })),
          },
        },
        {
          properties: { type: literal('legacy') },
          required: [
            'payloadCanonical',
            'transportFingerprint',
            'protocolVersion',
            'sourceTerminalId',
          ],
          not: { anyOf: [{ required: ['ledgerEventId'] }, { required: ['saleHash'] }] },
        },
      ],
    },
  ),
  syncReceipts: json(receiptProperties, Object.keys(receiptProperties), {
    oneOf: [
      { properties: { eventType: literal('ledger'), sequence: integer(1), hash } },
      {
        properties: {
          eventType: literal('legacy_order'),
          sequence: literal(null),
          hash: literal(null),
        },
      },
    ],
  }),
  catalogVersions: json({
    ...scope,
    versionId: uuid,
    revision: integer(1),
    schemaVersion: literal(1),
    payload: { ...payload, maxLength: 450000 },
    sha256: hash,
    publishedAt: date,
    author: embedded(subject),
  }),
  catalogHeads: json(
    {
      ...scope,
      revision: integer(),
      versionId: { anyOf: [uuid, { bsonType: 'null' }] },
      sha256: nullableHash,
    },
    [...Object.keys(scope), 'revision', 'versionId', 'sha256'],
    {
      oneOf: [
        { properties: { revision: literal(0), versionId: literal(null), sha256: literal(null) } },
        { properties: { revision: integer(1), versionId: uuid, sha256: hash } },
      ],
    },
  ),
  apiSessions: json({
    ...chain,
    ...subject,
    sessionId: uuid,
    installationId: uuid,
    enrollmentGeneration: integer(1),
    refreshHash: hash,
    familyId: uuid,
    active: bool,
    expiresAt: date,
    absoluteExpiresAt: date,
    fence: integer(),
  }),
  refreshRotations: json({
    sessionId: uuid,
    rotationId: uuid,
    previousRefreshHash: hash,
    proofHash: hash,
    responseCiphertext: { bsonType: 'string', minLength: 1, maxLength: 16384 },
    expiresAt: date,
  }),
  authChallenges: json(
    {
      purpose: { enum: ['session', 'enrollment'] },
      requestId: uuid,
      ...chain,
      ...subject,
      nonceHash: hash,
      installationId: uuid,
      enrollmentGeneration: integer(1),
      sessionId: uuid,
      keyFingerprint: hash,
      action: {
        enum: [
          'ledger-ingest-v1',
          'legacy-import-v1',
          'ledger-prefix-v1',
          'catalog-v1',
          'activate',
          'status',
          'authorize',
          'request',
          'refresh',
        ],
      },
      expiresAt: date,
      consumedAt: { bsonType: ['date', 'null'] },
    },
    [
      'purpose',
      'issuer',
      'subject',
      'nonceHash',
      'installationId',
      'keyFingerprint',
      'action',
      'expiresAt',
      'consumedAt',
    ],
    {
      oneOf: [
        {
          properties: {
            purpose: literal('session'),
            action: {
              enum: [
                'ledger-ingest-v1',
                'legacy-import-v1',
                'ledger-prefix-v1',
                'catalog-v1',
                'status',
                'refresh',
                'authorize',
              ],
            },
          },
          required: [...Object.keys(chain), 'enrollmentGeneration', 'sessionId'],
          not: { required: ['requestId'] },
        },
        {
          properties: {
            purpose: literal('enrollment'),
            action: { enum: ['request', 'activate', 'status', 'authorize'] },
          },
          oneOf: [
            { properties: { action: literal('request') }, not: { required: ['requestId'] } },
            {
              properties: { action: { enum: ['activate', 'status', 'authorize'] } },
              required: ['requestId'],
            },
          ],
          not: {
            anyOf: [...Object.keys(chain), 'enrollmentGeneration', 'sessionId'].map((field) => ({
              required: [field],
            })),
          },
        },
      ],
    },
  ),
  administrationAudit: json({
    ...scope,
    ...subject,
    auditId: uuid,
    action: id,
    idempotencyKey: id,
    requestFingerprint: hash,
    targetId: id,
    outcome: id,
    at: date,
  }),
  schemaMigrations: json({ version: integer(1), checksum: hash, appliedAt: date }),
}
const S = { organizationId: 1, festivalId: 1 } as const
const C = { ...S, chainId: 1 } as const
function unique(
  name: string,
  key: IndexDescription['key'],
  partialFilterExpression?: Document,
): IndexDescription {
  return {
    name,
    key,
    unique: true,
    collation: { locale: 'simple' },
    ...(partialFilterExpression ? { partialFilterExpression } : {}),
  }
}
const indexes: Record<keyof Documents, IndexDescription[]> = {
  organizations: [unique('organization_id', { organizationId: 1 })],
  festivals: [unique('festival_scope', S)],
  scopeGrants: [
    unique('grant_subject_scope_capability', { ...subjectKeys(), ...S, capability: 1 }),
  ],
  authorizationGuards: [unique('authorization_guard', { guardId: 1 })],
  chains: [unique('chain_id', { chainId: 1 }), unique('chain_scope', C)],
  installations: [
    unique('installation_id', { installationId: 1 }),
    unique('installation_subject', subjectKeys()),
    unique('installation_active_chain', C, { active: true }),
  ],
  installationKeys: [
    unique('installation_key_generation', { installationId: 1, enrollmentGeneration: 1 }),
  ],
  enrollmentRequests: [
    unique('enrollment_request', { requestId: 1 }),
    unique('enrollment_installation', { installationId: 1 }),
    unique('enrollment_invitation', { invitationHash: 1 }, { invitationHash: { $type: 'string' } }),
  ],
  terminalRanges: [unique('terminal_range_start', { ...C, firstSequence: 1 })],
  ledgerEvents: [
    unique('ledger_event', { ...C, eventId: 1 }),
    unique('ledger_sequence', { ...C, sequence: 1 }),
    unique(
      'ledger_operation',
      { ...C, kind: 1, operationId: 1 },
      { operationId: { $type: 'string' } },
    ),
    unique('ledger_session', { ...C, sessionId: 1 }, { kind: 'cash_session_opened' }),
  ],
  sales: [unique('sale_order_scope', { ...S, orderId: 1 })],
  syncReceipts: [
    unique('receipt_event', { ...C, eventType: 1, eventId: 1 }),
    unique('receipt_id', { receiptId: 1 }),
  ],
  catalogVersions: [
    unique('catalog_revision', { ...S, revision: 1 }),
    unique('catalog_version', { versionId: 1 }),
  ],
  catalogHeads: [unique('catalog_scope', S)],
  apiSessions: [
    unique('session_id', { sessionId: 1 }),
    unique('session_refresh', { refreshHash: 1 }),
  ],
  refreshRotations: [
    unique('refresh_rotation', { sessionId: 1, rotationId: 1 }),
    { name: 'refresh_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  authChallenges: [
    unique('challenge_nonce', { nonceHash: 1 }),
    { name: 'challenge_expiry', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  administrationAudit: [
    unique('audit_id', { auditId: 1 }),
    unique('audit_idempotency', { ...subjectKeys(), ...S, action: 1, idempotencyKey: 1 }),
  ],
  schemaMigrations: [unique('migration_version', { version: 1 })],
}
function subjectKeys() {
  return { issuer: 1, subject: 1 } as const
}

export const definitions = (Object.keys(validators) as (keyof Documents)[]).map((name) => ({
  name,
  validator: { $jsonSchema: validators[name] },
  indexes: indexes[name],
}))
