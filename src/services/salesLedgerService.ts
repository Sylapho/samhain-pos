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
  IndexedDbOrderRepository,
  type OrderRepository,
  type SalesLedgerRepository,
  verifySalesArchive,
} from './orderRepository'
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
  ) {}

  async cancelSale(
    originalOrderId: string,
    reason: string,
    operationId = this.createOperationId(),
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    const order = (await this.repository.getOrders()).find(
      (candidate) => candidate.id === originalOrderId,
    )
    if (!order) throw new Error(`Commande locale ${originalOrderId} introuvable.`)
    return this.recordCorrection(
      originalOrderId,
      'cancellation',
      -order.totalCents,
      reason,
      operationId,
      recordedAt,
    )
  }

  refundSale(
    originalOrderId: string,
    amountCents: number,
    reason: string,
    operationId = this.createOperationId(),
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('Le montant remboursé doit être un entier positif en centimes.')
    }
    return this.recordCorrection(
      originalOrderId,
      'refund',
      -amountCents,
      reason,
      operationId,
      recordedAt,
    )
  }

  adjustSale(
    originalOrderId: string,
    amountDeltaCents: number,
    reason: string,
    operationId = this.createOperationId(),
    recordedAt = new Date(),
  ): Promise<CorrectionLedgerEntry> {
    return this.recordCorrection(
      originalOrderId,
      'adjustment',
      amountDeltaCents,
      reason,
      operationId,
      recordedAt,
    )
  }

  closePeriod(
    periodStart: Date,
    periodEnd: Date,
    operationId = this.createOperationId(),
    recordedAt = new Date(),
  ): Promise<ClosureLedgerEntry> {
    const terminal = this.getTerminal()
    return this.repository.closePeriod({
      operationId,
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

  exportArchive(
    archiveId = this.createOperationId(),
    exportedAt = new Date(),
  ): Promise<SalesArchive> {
    const terminal = this.getTerminal()
    return this.repository.exportArchive(
      archiveId,
      exportedAt.toISOString(),
      this.buildLedgerSource(terminal),
    )
  }

  verifyArchive(archive: SalesArchive): IntegrityVerification {
    return verifySalesArchive(archive)
  }

  restoreArchive(archive: SalesArchive): Promise<ArchiveRestoreResult> {
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
    if (!globalThis.indexedDB) {
      throw new Error('Le stockage local durable IndexedDB est indisponible sur cet appareil.')
    }
    defaultSalesLedgerService = new SalesLedgerService(
      new IndexedDbOrderRepository(globalThis.indexedDB),
    )
  }
  return defaultSalesLedgerService
}
