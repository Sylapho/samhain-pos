import type {
  ArchiveRestoreResult,
  ClosureLedgerEntry,
  CorrectionLedgerEntry,
  IntegrityVerification,
  LedgerSource,
  SalesArchive,
  SalesLedgerEntry,
} from '../types/salesLedger'
import type { TerminalConfiguration, TerminalIdentity } from '../types/terminal'
import { createLedgerSource } from './ledgerSource'
import {
  type OrderRepository,
  type SalesLedgerRepository,
  verifySalesArchive,
} from './orderRepository'
import { getOrderDataRepository } from './orderRepositoryFactory'
import { getResponsibleModeService } from './responsibleModeService'
import { getRequiredTerminalConfiguration } from './terminalConfigurationService'

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

  refundSale(
    originalOrderId: string,
    amountCents: number,
    reason: string,
    operationId?: string,
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    this.requireResponsibleMode()
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('Le montant remboursé doit être un entier positif en centimes.')
    }
    return this.recordCorrection(
      originalOrderId,
      'refund',
      -amountCents,
      reason,
      operationId ?? this.createOperationId(),
      recordedAt,
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
    const terminal = this.getTerminal()
    return this.repository.closePeriod({
      operationId: operationId ?? this.createOperationId(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      recordedAt: recordedAt.toISOString(),
      source: this.buildLedgerSource(terminal),
    })
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
    return this.repository.restoreArchive(archive)
  }

  private recordCorrection(
    originalOrderId: string,
    type: 'cancellation' | 'refund' | 'adjustment',
    amountDeltaCents: number,
    reason: string,
    operationId: string,
    recordedAt: Date,
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

let defaultSalesLedgerService: SalesLedgerService | null = null

export function getSalesLedgerService(): SalesLedgerService {
  if (!defaultSalesLedgerService) {
    defaultSalesLedgerService = new SalesLedgerService(getOrderDataRepository())
  }
  return defaultSalesLedgerService
}
