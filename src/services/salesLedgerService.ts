import type {
  ArchiveRestoreResult,
  ClosureLedgerEntry,
  ClosurePreview,
  ClosureVatBreakdown,
  CorrectionLedgerEntry,
  IntegrityVerification,
  LedgerSource,
  SalesArchive,
  SalesLedgerEntry,
  RefundLineSelection,
} from '../types/salesLedger'
import type { TerminalConfiguration, TerminalIdentity } from '../types/terminal'
import { terminalCodes } from '../types/terminal'
import { createLedgerSource } from './ledgerSource'
import {
  calculateClosureTotals,
  calculateTheoreticalCashCents,
  getActiveCashSession,
  type OrderRepository,
  type SalesLedgerRepository,
  verifySalesArchive,
} from './orderRepository'
import { getOrderDataRepository } from './orderRepositoryFactory'
import { getResponsibleModeService } from './responsibleModeService'
import { getRequiredTerminalConfiguration } from './terminalConfigurationService'
import { buildRefundLines, refundLinesTotalCents } from './saleRefund'
import { calculateIncludedVatCents } from '../utils/vat'

type LedgerDataRepository = OrderRepository & SalesLedgerRepository

export class SalesLedgerService {
  constructor(
    private readonly repository: LedgerDataRepository,
    private readonly createOperationId: () => string = () => globalThis.crypto.randomUUID(),
    private readonly loadTerminalConfiguration: () => TerminalConfiguration = getRequiredTerminalConfiguration,
    private readonly buildLedgerSource: (
      terminal: TerminalIdentity,
    ) => LedgerSource = createLedgerSource,
    private readonly requireResponsibleMode: () => void = () =>
      getResponsibleModeService().requireUnlocked(),
  ) {}

  async cancelSale(
    originalOrderId: string,
    reason: string,
    operationId?: string,
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    this.requireResponsibleMode()
    const order = (await this.repository.getOrders()).find(
      (candidate) => candidate.id === originalOrderId,
    )
    if (!order) throw new Error(`Commande locale ${originalOrderId} introuvable.`)
    return this.recordCorrection(
      originalOrderId,
      'cancellation',
      -order.totalCents,
      reason,
      operationId ?? this.createOperationId(),
      recordedAt,
    )
  }

  async refundSale(
    originalOrderId: string,
    selections: RefundLineSelection[],
    reason: string,
    operationId?: string,
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    this.requireResponsibleMode()
    const resolvedOperationId = operationId ?? this.createOperationId()
    const [orders, entries] = await Promise.all([
      this.repository.getOrders(),
      this.repository.getLedgerEntries(),
    ])
    const existing = entries.find(
      (entry): entry is CorrectionLedgerEntry =>
        entry.kind === 'correction' && entry.correction.operationId === resolvedOperationId,
    )
    if (existing) {
      const existingSelections = existing.correction.refundLines?.map(
        ({ originalLineId, quantity }) => ({ originalLineId, quantity }),
      )
      if (
        existing.correction.type === 'refund' &&
        existing.correction.originalOrderId === originalOrderId &&
        existing.correction.reason === reason.trim() &&
        existingSelections?.length === selections.length &&
        existingSelections.every(
          (selection, index) =>
            selection.originalLineId === selections[index]?.originalLineId &&
            selection.quantity === selections[index]?.quantity,
        )
      ) {
        return existing
      }
      throw new Error('Cette clé d’opération appartient déjà à une autre correction.')
    }
    const order = orders.find((candidate) => candidate.id === originalOrderId)
    if (!order) throw new Error(`Commande locale ${originalOrderId} introuvable.`)
    const corrections = entries.filter(
      (entry): entry is CorrectionLedgerEntry => entry.kind === 'correction',
    )
    const refundLines = buildRefundLines(order, selections, corrections)
    return this.recordCorrection(
      originalOrderId,
      'refund',
      -refundLinesTotalCents(refundLines),
      reason,
      resolvedOperationId,
      recordedAt,
      refundLines,
    )
  }

  adjustSale(
    originalOrderId: string,
    amountDeltaCents: number,
    reason: string,
    operationId?: string,
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    this.requireResponsibleMode()
    return this.recordCorrection(
      originalOrderId,
      'adjustment',
      amountDeltaCents,
      reason,
      operationId ?? this.createOperationId(),
      recordedAt,
    )
  }

  closePeriod(
    periodStart: Date,
    periodEnd: Date,
    operationId?: string,
    recordedAt = new Date(),
  ): Promise<ClosureLedgerEntry> {
    this.requireResponsibleMode()
    validateClosurePeriod(periodStart, periodEnd, recordedAt)
    return this.closeActiveSession(periodStart, periodEnd, operationId, recordedAt)
  }

  private async closeActiveSession(
    periodStart: Date,
    periodEnd: Date,
    operationId: string | undefined,
    recordedAt: Date,
  ): Promise<ClosureLedgerEntry> {
    const terminal = this.getTerminal()
    const cashSession = getActiveCashSession(await this.repository.getLedgerEntries())
    if (!cashSession || cashSession.terminal.terminalId !== terminal.terminalId) {
      throw new Error('Aucune session de caisse active ne peut être clôturée.')
    }
    if (periodStart.toISOString() !== cashSession.periodStart) {
      throw new Error('La clôture doit commencer au début de la session de caisse active.')
    }
    return this.repository.closePeriod({
      operationId: operationId ?? this.createOperationId(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      recordedAt: recordedAt.toISOString(),
      source: this.buildLedgerSource(terminal),
      cashSessionId: cashSession.id,
      openingFloatCents: cashSession.openingFloatCents,
    })
  }

  async previewClosure(
    periodStart: Date,
    periodEnd: Date,
    currentTime = new Date(),
  ): Promise<ClosurePreview> {
    this.requireResponsibleMode()
    validateClosurePeriod(periodStart, periodEnd, currentTime)
    const [integrity, entries] = await Promise.all([
      this.repository.verifyIntegrity(),
      this.repository.getLedgerEntries(),
    ])
    if (!integrity.valid) {
      throw new Error(`Prévisualisation refusée : ${integrity.errors.join(' ')}`)
    }

    const periodStartIso = periodStart.toISOString()
    const periodEndIso = periodEnd.toISOString()
    const lastClosureEnd = entries
      .filter((entry): entry is ClosureLedgerEntry => entry.kind === 'closure')
      .at(-1)?.closure.periodEnd
    if (lastClosureEnd && periodStartIso !== lastClosureEnd) {
      throw new Error('La nouvelle clôture doit commencer à la fin de la précédente.')
    }

    const cashSession = getActiveCashSession(entries)
    if (!cashSession || cashSession.terminal.terminalId !== this.getTerminal().terminalId) {
      throw new Error('Aucune session de caisse active ne peut être clôturée.')
    }
    if (cashSession.periodStart !== periodStartIso) {
      throw new Error('La clôture doit commencer au début de la session de caisse active.')
    }

    const totals = calculateClosureTotals(entries, periodStartIso, periodEndIso)
    const vat = calculateClosureVat(entries, periodStartIso, periodEndIso)
    return {
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      terminal: this.getTerminal(),
      totals,
      cashSession,
      theoreticalCashCents: calculateTheoreticalCashCents(
        cashSession.openingFloatCents,
        totals.paymentTotalsCents.cash,
      ),
      integrity,
      vatBreakdown: vat.breakdown,
      ...(vat.unavailableReason ? { vatUnavailableReason: vat.unavailableReason } : {}),
    }
  }

  async getLastClosureEnd(): Promise<string | null> {
    this.requireResponsibleMode()
    return (
      (await this.repository.getLedgerEntries())
        .filter((entry): entry is ClosureLedgerEntry => entry.kind === 'closure')
        .at(-1)?.closure.periodEnd ?? null
    )
  }

  getEntries(): Promise<SalesLedgerEntry[]> {
    return this.repository.getLedgerEntries()
  }

  verifyIntegrity(): Promise<IntegrityVerification> {
    return this.repository.verifyIntegrity()
  }

  exportArchive(archiveId?: string, exportedAt = new Date()): Promise<SalesArchive> {
    this.requireResponsibleMode()
    const terminal = this.getTerminal()
    return this.repository.exportArchive(
      archiveId ?? this.createOperationId(),
      exportedAt.toISOString(),
      this.buildLedgerSource(terminal),
    )
  }

  verifyArchive(archive: SalesArchive): IntegrityVerification {
    return verifySalesArchive(archive)
  }

  restoreArchive(archive: SalesArchive): Promise<ArchiveRestoreResult> {
    this.requireResponsibleMode()
    const verification = verifySalesArchive(archive)
    if (!verification.valid) {
      throw new Error(`Restauration refusée : ${verification.errors.join(' ')}`)
    }
    const current = this.getTerminal()
    const source = requireArchiveTerminalIdentity(archive)
    if (current.terminalCode !== source.terminalCode) {
      throw new Error(
        `Cette archive appartient à Caisse ${source.terminalCode} et ne peut pas être restaurée sur Caisse ${current.terminalCode}.`,
      )
    }
    if (current.terminalId !== source.terminalId) {
      throw new Error(
        `Cette archive utilise une autre identité technique pour Caisse ${source.terminalCode}.`,
      )
    }
    return this.repository.restoreArchive(archive)
  }

  private recordCorrection(
    originalOrderId: string,
    type: 'cancellation' | 'refund' | 'adjustment',
    amountDeltaCents: number,
    reason: string,
    operationId: string,
    recordedAt: Date,
    refundLines?: ReturnType<typeof buildRefundLines>,
  ): Promise<CorrectionLedgerEntry> {
    const terminal = this.getTerminal()
    return this.repository.recordCorrection({
      operationId,
      originalOrderId,
      type,
      reason: reason.trim(),
      amountDeltaCents,
      recordedAt: recordedAt.toISOString(),
      source: this.buildLedgerSource(terminal),
      ...(refundLines ? { refundLines } : {}),
    })
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

function validateClosurePeriod(periodStart: Date, periodEnd: Date, currentTime: Date): void {
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    Number.isNaN(currentTime.getTime())
  ) {
    throw new Error('Les dates de clôture sont invalides.')
  }
  if (periodStart.getTime() >= periodEnd.getTime()) {
    throw new Error('La fin de période doit être postérieure à son début.')
  }
  if (periodEnd.getTime() > currentTime.getTime()) {
    throw new Error('Une période future ne peut pas être clôturée.')
  }
}

function calculateClosureVat(
  entries: SalesLedgerEntry[],
  periodStart: string,
  periodEnd: string,
): { breakdown: ClosureVatBreakdown[] | null; unavailableReason?: string } {
  const byRate = new Map<number, ClosureVatBreakdown>()
  const add = (rate: number, grossCents: number, vatCents: number) => {
    const current = byRate.get(rate) ?? { rate, grossCents: 0, netCents: 0, vatCents: 0 }
    current.grossCents += grossCents
    current.vatCents += vatCents
    current.netCents += grossCents - vatCents
    byRate.set(rate, current)
  }
  for (const entry of entries) {
    if (
      entry.kind === 'sale' &&
      entry.order.paidAt >= periodStart &&
      entry.order.paidAt < periodEnd
    ) {
      for (const item of entry.order.items) {
        if (!Number.isFinite(item.vatRate)) {
          return {
            breakdown: null,
            unavailableReason: 'Ventilation TVA indisponible pour certaines données persistées.',
          }
        }
        const grossCents = item.unitPriceCents * item.quantity
        add(item.vatRate, grossCents, calculateIncludedVatCents(grossCents, item.vatRate))
      }
    }
    if (
      entry.kind !== 'correction' ||
      entry.recordedAt < periodStart ||
      entry.recordedAt >= periodEnd
    )
      continue

    if (entry.correction.type === 'refund' && entry.correction.refundLines) {
      for (const line of entry.correction.refundLines) {
        add(line.vatRate, -line.grossCents, -line.vatCents)
      }
      continue
    }
    if (entry.correction.type === 'cancellation') {
      const original = entries.find(
        (candidate) =>
          candidate.kind === 'sale' && candidate.order.id === entry.correction.originalOrderId,
      )
      if (!original || original.kind !== 'sale') {
        return {
          breakdown: null,
          unavailableReason: 'Ventilation TVA indisponible pour certaines données persistées.',
        }
      }
      for (const item of original.order.items) {
        const grossCents = item.unitPriceCents * item.quantity
        add(item.vatRate, -grossCents, -calculateIncludedVatCents(grossCents, item.vatRate))
      }
      continue
    }
    return {
      breakdown: null,
      unavailableReason:
        'Ventilation TVA indisponible : une correction historique ne contient pas de détail fiscal fiable.',
    }
  }
  return { breakdown: [...byRate.values()].sort((left, right) => left.rate - right.rate) }
}

export function requireArchiveTerminalIdentity(archive: SalesArchive): TerminalIdentity {
  const terminal = archive.source?.terminal
  if (
    !terminal ||
    typeof terminal.terminalId !== 'string' ||
    !terminal.terminalId.trim() ||
    !terminalCodes.includes(terminal.terminalCode) ||
    typeof terminal.displayName !== 'string' ||
    !terminal.displayName.trim()
  ) {
    throw new Error('Restauration refusée : l’identité terminal de l’archive est invalide.')
  }
  return terminal
}

let defaultSalesLedgerService: SalesLedgerService | null = null

export function getSalesLedgerService(): SalesLedgerService {
  if (!defaultSalesLedgerService) {
    defaultSalesLedgerService = new SalesLedgerService(getOrderDataRepository())
  }
  return defaultSalesLedgerService
}
