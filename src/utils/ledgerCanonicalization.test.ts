import { describe, expect, it } from 'vitest'
import { canonicalLedger, originalLedgerProfile } from './ledgerCanonicalization'
import { sha256Hex } from './integrity'

describe('profils historiques du journal', () => {
  it.each(['ts-ledger-v1', 'android-ledger-v1'] as const)(
    'identifie %s sans modifier son hash',
    (profile) => {
      const payload = { id: 'opaque/é😀', sequence: 1, previousHash: null }
      const hash = sha256Hex(canonicalLedger(payload, profile))
      const entry = { ...payload, hash }
      expect(originalLedgerProfile(entry)).toBe(profile)
      expect(entry.hash).toBe(hash)
      expect(JSON.parse(canonicalLedger(entry, profile))).toEqual(entry)
    },
  )
  it('refuse de fabriquer un profil pour un hash inconnu', () => {
    expect(originalLedgerProfile({ hash: '0'.repeat(64) })).toBeNull()
  })
})
