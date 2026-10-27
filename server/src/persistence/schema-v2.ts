import type { Document } from 'mongodb'
import { definitions as baseline } from './schema-v1.ts'

const uuid = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}
const hash = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' }
const date = { bsonType: 'date' }
const cipher = { bsonType: 'string', minLength: 1, maxLength: 1048576 }
const additions: Record<string, Document> = {
  enrollmentRequests: {
    authVersion: { enum: [1] },
    operationRequestId: uuid,
    requestFingerprint: hash,
    decisionOperationId: uuid,
    decisionFingerprint: hash,
    expectedGeneration: {
      bsonType: ['int', 'long', 'double'],
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      multipleOf: 1,
    },
    expectedInstallationId: { anyOf: [uuid, { bsonType: 'null' }] },
    activationOperationId: uuid,
    activationFingerprint: hash,
    activationResponseCiphertext: cipher,
    responseExpiresAt: date,
  },
  installations: { authVersion: { enum: [1] }, revokedAt: date },
  apiSessions: { authVersion: { enum: [1] }, keyFingerprint: hash },
  refreshRotations: { authVersion: { enum: [1] } },
}
// Frozen v1 baseline; validator expansion does not rewrite historical documents.
export const definitions = baseline.map((definition) => {
  const copy = structuredClone(definition)
  const fields = additions[definition.name]
  if (fields) Object.assign(copy.validator.$jsonSchema.properties, fields)
  if (definition.name === 'refreshRotations')
    copy.indexes.push({
      name: 'refresh_old_hash',
      key: { sessionId: 1, previousRefreshHash: 1 },
      unique: true,
      collation: { locale: 'simple' },
    })
  return copy
})
