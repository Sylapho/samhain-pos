import { loadConfig } from '../src/config.ts'
import type { Database } from '../src/database.ts'
import type { Principal, AccessPolicy } from '../src/auth.ts'

export const environment = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27019/',
  MONGODB_DATABASE: 'samhain_test_unit',
  MONGODB_TLS: 'false',
  LOG_LEVEL: 'silent',
}
export const config = () => loadConfig(environment)
export const scope = { organizationId: 'organization', festivalId: 'festival' }
export const policy: AccessPolicy = { kind: 'manager', scope, capability: 'read_ledger' }
export const principal: Principal = {
  kind: 'manager',
  subject: 'verified-subject',
  grants: [{ scope, capability: 'read_ledger' }],
}
export function fakeDatabase(): Database & {
  checks: number
  closes: number
  connects: number
  available: boolean
} {
  return {
    checks: 0,
    closes: 0,
    connects: 0,
    available: true,
    async connect() {
      this.connects++
    },
    async check() {
      this.checks++
      if (!this.available) throw new Error('mongodb://user:secret@private/')
    },
    async close() {
      this.closes++
    },
  }
}
