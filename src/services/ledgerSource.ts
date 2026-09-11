import packageInformation from '../../package.json'
import { receiptBusinessInfo } from '../config/organization'
import type { LedgerSource } from '../types/salesLedger'
import type { TerminalIdentity } from '../types/terminal'

export function createLedgerSource(terminal: TerminalIdentity): LedgerSource {
  return {
    softwareVersion: packageInformation.version,
    buildMode: import.meta.env.MODE,
    terminal: structuredClone(terminal),
    organization: structuredClone(receiptBusinessInfo),
  }
}
