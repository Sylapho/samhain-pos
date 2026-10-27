import { definitions as previous } from './schema-v2.ts'

const uuid = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}
// Additive expansion: old unscoped requests remain valid, v1/v2 checksums stay frozen.
export const definitions = previous.map((definition) => {
  const copy = structuredClone(definition)
  if (copy.name === 'enrollmentRequests') {
    Object.assign(copy.validator.$jsonSchema.properties, {
      requestedScope: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['organizationId', 'festivalId'],
        properties: { organizationId: uuid, festivalId: uuid },
      },
    })
  }
  return copy
})
