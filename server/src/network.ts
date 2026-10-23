import { BlockList, isIP } from 'node:net'

// Only literal addresses/CIDRs: no DNS lookup or implicit trust in an entire proxy chain.
export function networkMatcher(entries: readonly string[]): (address: string) => boolean {
  const list = new BlockList()
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.split('/')
    const version = isIP(address)
    if (!version || extra !== undefined) throw new Error('Invalid network allowlist')
    const family = version === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) list.addAddress(address, family)
    else {
      if (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128))
        throw new Error('Invalid network allowlist')
      list.addSubnet(address, Number(prefix), family)
    }
  }
  return (address) => {
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
    return list.check(normalized, isIP(normalized) === 6 ? 'ipv6' : 'ipv4')
  }
}
