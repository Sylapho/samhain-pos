import { createHash } from 'node:crypto'
import type { Db, Document, IndexDescriptionInfo } from 'mongodb'
import { definitions } from './schema.ts'
import { PersistenceError } from './errors.ts'
import type { SchemaMigration } from './model.ts'

export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
      .join(',') +
    '}'
  )
}
export const migration = {
  version: 1,
  checksum: createHash('sha256').update(stable(definitions)).digest('hex'),
}

export async function verifyTopology(db: Db, signal?: AbortSignal): Promise<void> {
  const hello = await db.command({ hello: 1 }, { ...(signal ? { signal } : {}) })
  // Sharding is deliberately not enabled: global unique IDs require a separate design review.
  if (
    !hello.setName ||
    hello.msg === 'isdbgrid' ||
    hello.logicalSessionTimeoutMinutes == null ||
    hello.maxWireVersion < 17
  )
    throw new PersistenceError('TRANSACTIONS_REQUIRED')
}

function checkIndex(collection: string, expected: Document, actual: IndexDescriptionInfo): void {
  // Key order is significant for compound indexes; option object order is not.
  if (
    JSON.stringify(Object.entries(actual.key)) !== JSON.stringify(Object.entries(expected.key)) ||
    Boolean(actual.unique) !== Boolean(expected.unique) ||
    Boolean(actual.sparse) ||
    Boolean(actual.hidden) ||
    stable(actual.partialFilterExpression ?? null) !==
      stable(expected.partialFilterExpression ?? null) ||
    (actual.collation?.locale ?? 'simple') !== (expected.collation?.locale ?? 'simple') ||
    actual.expireAfterSeconds !== expected.expireAfterSeconds
  )
    throw new PersistenceError('INDEX_INCOMPATIBLE', collection, String(expected.name))
}

async function inspect(db: Db, complete: boolean, signal?: AbortSignal): Promise<void> {
  const options = signal ? { signal } : {}
  const collections = await db.listCollections({}, { ...options, nameOnly: false }).toArray()
  for (const definition of definitions) {
    const existing = collections.find((item) => item.name === definition.name)
    if (!existing) {
      if (complete) throw new PersistenceError('SCHEMA_INCOMPATIBLE', definition.name)
      continue
    }
    const settings = existing.options ?? {}
    if (
      existing.type !== 'collection' ||
      settings.capped ||
      settings.timeseries ||
      (settings.collation?.locale ?? 'simple') !== 'simple'
    )
      throw new PersistenceError('SCHEMA_INCOMPATIBLE', definition.name)
    if (
      settings.validator &&
      Object.keys(settings.validator).length &&
      stable(settings.validator) !== stable(definition.validator)
    )
      throw new PersistenceError('SCHEMA_INCOMPATIBLE', definition.name)
    if (
      complete &&
      (stable(settings.validator) !== stable(definition.validator) ||
        settings.validationLevel !== 'strict' ||
        settings.validationAction !== 'error')
    )
      throw new PersistenceError('SCHEMA_INCOMPATIBLE', definition.name)
    // Never silently convert historical or foreign documents to version 1.
    if (
      !complete &&
      (await db
        .collection(definition.name)
        .findOne({ $nor: [definition.validator] }, { ...options, projection: { _id: 1 } }))
    )
      throw new PersistenceError('INVALID_DOCUMENT', definition.name)
    signal?.throwIfAborted()
    const indexes = await db.collection(definition.name).listIndexes().toArray()
    for (const actual of indexes) {
      if (actual.name === '_id_') continue
      const expected = definition.indexes.find((index) => index.name === actual.name)
      if (expected) checkIndex(definition.name, expected, actual)
      else if (actual.unique || actual.expireAfterSeconds !== undefined)
        throw new PersistenceError('INDEX_INCOMPATIBLE', definition.name, actual.name)
    }
    if (complete)
      for (const expected of definition.indexes) {
        const actual = indexes.find((index) => index.name === expected.name)
        if (!actual)
          throw new PersistenceError('INDEX_INCOMPATIBLE', definition.name, expected.name)
        checkIndex(definition.name, expected, actual)
      }
  }
  if (collections.some((item) => item.name === 'schemaMigrations')) {
    for (const record of await db
      .collection<SchemaMigration>('schemaMigrations')
      .find({}, options)
      .toArray()) {
      if (
        record.version !== migration.version ||
        record.checksum !== migration.checksum ||
        record.documentSchemaVersion !== 1
      )
        throw new PersistenceError('SCHEMA_INCOMPATIBLE', 'schemaMigrations')
    }
  }
}

export async function verifySchema(db: Db, signal?: AbortSignal): Promise<void> {
  await verifyTopology(db, signal)
  await inspect(db, true, signal)
  const record = await db
    .collection<SchemaMigration>('schemaMigrations')
    .findOne({ version: migration.version }, signal ? { signal } : {})
  if (!record || record.checksum !== migration.checksum)
    throw new PersistenceError('SCHEMA_INCOMPATIBLE', 'schemaMigrations')
}

export async function migrate(db: Db): Promise<void> {
  await verifyTopology(db)
  // Validate the entire namespace before any DDL. DDL is not transactional; a failed
  // index build leaves additive work that can be inspected and safely resumed.
  await inspect(db, false)
  for (const definition of definitions) {
    const existing = await db.listCollections({ name: definition.name }, { nameOnly: false }).next()
    if (!existing) {
      await db.createCollection(definition.name, {
        validator: definition.validator,
        validationLevel: 'strict',
        validationAction: 'error',
        collation: { locale: 'simple' },
      })
    } else if (
      stable(existing.options?.validator) !== stable(definition.validator) ||
      existing.options?.validationLevel !== 'strict' ||
      existing.options?.validationAction !== 'error'
    ) {
      await db.command({
        collMod: definition.name,
        validator: definition.validator,
        validationLevel: 'strict',
        validationAction: 'error',
      })
    }
    const indexes = await db.collection(definition.name).listIndexes().toArray()
    for (const index of definition.indexes)
      if (!indexes.some((item) => item.name === index.name)) {
        try {
          await db.collection(definition.name).createIndexes([index])
        } catch {
          throw new PersistenceError('INDEX_INCOMPATIBLE', definition.name, index.name)
        }
      }
  }
  const records = db.collection<SchemaMigration>('schemaMigrations')
  if (!(await records.findOne({ version: migration.version })))
    await records.insertOne({ ...migration, documentSchemaVersion: 1, appliedAt: new Date() })
  await verifySchema(db)
}
