import type { CashSession, LedgerSource, SalesLedgerEntry } from '../types/salesLedger'
import type { TerminalConfiguration, TerminalIdentity } from '../types/terminal'
import { createLedgerSource } from './ledgerSource'
import { getActiveCashSession, type SalesLedgerRepository } from './orderRepository'
import { getOrderDataRepository } from './orderRepositoryFactory'
import { getResponsibleModeService } from './responsibleModeService'
import { getRequiredTerminalConfiguration } from './terminalConfigurationService'

export class CashSessionService {
  constructor(
    private readonly repository: SalesLedgerRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
    private readonly loadTerminalConfiguration: () => TerminalConfiguration = getRequiredTerminalConfiguration,
    private readonly buildLedgerSource: (
      terminal: TerminalIdentity,
    ) => LedgerSource = createLedgerSource,
    private readonly requireResponsibleMode: () => void = () =>
      getResponsibleModeService().requireUnlocked(),
  ) {}

  async getActiveSession(): Promise<CashSession | null> {
    const session = getActiveCashSession(await this.repository.getLedgerEntries())
    if (!session) return null
    const terminal = this.getTerminal()
    if (session.terminal.terminalId !== terminal.terminalId) {
      throw new Error('La session ouverte appartient à une autre identité de caisse.')
    }
    return session
  }

  async openSession(openingFloatCents: number, createdAt = new Date()): Promise<CashSession> {
    validateOpeningFloat(openingFloatCents)
    const createdAtIso = requireValidDate(createdAt)
    const entries = await this.repository.getLedgerEntries()
    const existing = getActiveCashSession(entries)
    const terminal = this.getTerminal()
    if (existing) {
      if (existing.terminal.terminalId !== terminal.terminalId) {
        throw new Error('La session ouverte appartient à une autre identité de caisse.')
      }
      if (existing.openingFloatCents === openingFloatCents) return existing
      throw new Error('Une session de caisse est déjà ouverte avec un autre fond.')
    }
    const sessionId = this.createId()
    const entry = await this.repository.openCashSession({
      sessionId,
      periodStart: sessionPeriodStart(entries, createdAtIso),
      openingFloatCents,
      createdAt: createdAtIso,
      recordedAt: createdAtIso,
      source: this.buildLedgerSource(terminal),
    })
    return {
      id: entry.session.sessionId,
      terminal: structuredClone(entry.source.terminal),
      periodStart: entry.session.periodStart,
      createdAt: entry.session.createdAt,
      openingFloatCents: entry.session.openingFloatCents,
    }
  }

  async updateOpeningFloat(
    newOpeningFloatCents: number,
    updatedAt = new Date(),
  ): Promise<CashSession> {
    this.requireResponsibleMode()
    validateOpeningFloat(newOpeningFloatCents)
    const session = await this.getActiveSession()
    if (!session) throw new Error('Aucune session de caisse active à modifier.')
    if (session.openingFloatCents === newOpeningFloatCents) return session
    const updatedAtIso = requireValidDate(updatedAt)
    await this.repository.updateCashFloat({
      operationId: this.createId(),
      sessionId: session.id,
      previousOpeningFloatCents: session.openingFloatCents,
      newOpeningFloatCents,
      updatedAt: updatedAtIso,
      recordedAt: updatedAtIso,
      source: this.buildLedgerSource(this.getTerminal()),
    })
    return { ...session, openingFloatCents: newOpeningFloatCents, updatedAt: updatedAtIso }
  }

  private getTerminal(): TerminalIdentity {
    const terminal = this.loadTerminalConfiguration()
    return {
      terminalId: terminal.terminalId,
      terminalCode: terminal.terminalCode,
      displayName: terminal.displayName,
    }
  }
}

export function validateOpeningFloat(openingFloatCents: number): void {
  if (!Number.isSafeInteger(openingFloatCents) || openingFloatCents < 0) {
    throw new Error('Le fond de caisse doit être un montant positif ou nul en centimes.')
  }
}

function sessionPeriodStart(entries: SalesLedgerEntry[], createdAt: string): string {
  const lastClosure = entries.filter((entry) => entry.kind === 'closure').at(-1)
  if (lastClosure?.kind === 'closure') return lastClosure.closure.periodEnd

  const firstFinancialTimestamp = entries
    .flatMap((entry) => {
      if (entry.kind === 'sale') return [entry.order.paidAt]
      if (entry.kind === 'correction') return [entry.recordedAt]
      return []
    })
    .sort()[0]
  return firstFinancialTimestamp && firstFinancialTimestamp < createdAt
    ? firstFinancialTimestamp
    : createdAt
}

function requireValidDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('La date de la session de caisse est invalide.')
  return date.toISOString()
}

let defaultCashSessionService: CashSessionService | null = null

export function getCashSessionService(): CashSessionService {
  defaultCashSessionService ??= new CashSessionService(getOrderDataRepository())
  return defaultCashSessionService
}
