import { canonicalJson, sha256Hex } from './integrity'

export type LedgerCanonicalization = 'ts-ledger-v1' | 'android-ledger-v1'

export function canonicalLedger(value: unknown, profile: LedgerCanonicalization): string {
  const canonical = canonicalJson(value)
  return profile === 'android-ledger-v1' ? canonical.replaceAll('/', '\\/') : canonical
}

/** Select an existing reproducible profile; never change the stored financial digest. */
export function originalLedgerProfile(entry: { hash: string }): LedgerCanonicalization | null {
  const { hash, ...unsigned } = entry
  for (const profile of ['ts-ledger-v1', 'android-ledger-v1'] as const) {
    if (sha256Hex(canonicalLedger(unsigned, profile)) === hash) return profile
  }
  return null
}
