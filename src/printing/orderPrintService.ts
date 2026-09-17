import { assertReceiptBusinessInfoCanBePrinted } from '../config/organization'
import { printerProfile } from '../config/printer'
import type { Order } from '../types/order'
import { getResponsibleModeService } from '../services/responsibleModeService'
import { CapacitorReceiptPrinter } from './capacitorReceiptPrinter'
import { renderCustomerReceipt } from './customerReceiptRenderer'
import { bytesToBase64 } from './escPos'
import { orderRequiresPickupTicket, orderRequiresPreparation } from '../utils/preparation'
import { renderPreparationTicket } from './preparationTicketRenderer'
import { renderPickupTicket } from './pickupTicketRenderer'
import { getRetryableDocuments, uniquePrintSelection } from './orderPrinting'
import { OrderPrintError } from './types'
import type {
  PrintDocumentType,
  PrintJobResult,
  PrintJobStep,
  PrintSelection,
  ReceiptPrinter,
  RenderedTicket,
} from './types'
import { printDocumentTypes } from './types'

export type PrintOrderOptions = {
  selection?: PrintSelection
  deviceId?: number
  reprint?: boolean
}

export type BuiltOrderPrintJob = {
  documents: RenderedTicket[]
  steps: PrintJobStep[]
}

export function getCompletedDocumentsFromPrintError(
  error: unknown,
  options: PrintOrderOptions = {},
): PrintDocumentType[] {
  if (!(error instanceof OrderPrintError)) return []
  if (error.completedDocuments !== undefined) return error.completedDocuments
  const selection = uniquePrintSelection(options.selection ?? printDocumentTypes)
  const failedDocument =
    error.stage === 'pickupTicket' || error.stage === 'pickupCut'
      ? 'pickupTicket'
      : error.stage === 'customerReceipt' || error.stage === 'customerCut'
        ? 'customerReceipt'
        : error.stage === 'preparationTicket' || error.stage === 'preparationCut'
          ? 'preparationTicket'
          : null
  if (!failedDocument) return []
  const failedIndex = selection.indexOf(failedDocument)
  const documentWasWritten = error.stage.endsWith('Cut')
  return failedIndex < 0 ? [] : selection.slice(0, failedIndex + (documentWasWritten ? 1 : 0))
}

export function getUnknownDocumentsFromPrintError(error: unknown): PrintDocumentType[] {
  if (!(error instanceof OrderPrintError)) return []
  return error.unknownDocuments ?? []
}

export function buildOrderPrintJob(
  order: Order,
  options: PrintOrderOptions = {},
): BuiltOrderPrintJob {
  const selection = uniquePrintSelection(options.selection ?? printDocumentTypes)
  const documents: RenderedTicket[] = []

  if (selection.includes('pickupTicket') && orderRequiresPickupTicket(order)) {
    documents.push(renderPickupTicket(order))
  }
  if (selection.includes('customerReceipt')) {
    try {
      assertReceiptBusinessInfoCanBePrinted()
    } catch (error) {
      throw new OrderPrintError(
        error instanceof Error ? error.message : 'Configuration du ticket client invalide.',
        'configuration',
        'RECEIPT_BUSINESS_INFO_INVALID',
      )
    }
    documents.push(renderCustomerReceipt(order))
  }
  const preparationRequired = orderRequiresPreparation(order)
  if (selection.includes('preparationTicket') && preparationRequired) {
    documents.push(renderPreparationTicket(order))
  }

  const steps: PrintJobStep[] = documents.flatMap((document) => [
    {
      type: 'document' as const,
      documentType: document.type,
      dataBase64: bytesToBase64(document.bytes),
    },
    {
      type: 'cut' as const,
      afterDocument: document.type,
      feedLines: printerProfile.feedLinesBeforeCut,
      cutMode: printerProfile.cutMode,
    },
  ])

  const onlyInapplicableOperationalDocuments =
    selection.length > 0 &&
    selection.every(
      (document) =>
        (document === 'pickupTicket' || document === 'preparationTicket') && !preparationRequired,
    )
  if (!steps.length && !onlyInapplicableOperationalDocuments) {
    throw new OrderPrintError(
      'Aucun ticket n’a été sélectionné pour cette impression.',
      'configuration',
      'NO_PRINT_DOCUMENT_SELECTED',
    )
  }

  return { documents, steps }
}

export class OrderPrintService {
  constructor(
    private readonly printer: ReceiptPrinter,
    private readonly requireResponsibleMode: () => void = () =>
      getResponsibleModeService().requireUnlocked(),
  ) {}

  async printOrder(order: Order, options: PrintOrderOptions = {}): Promise<PrintJobResult> {
    if (isProtectedCustomerReprint(order, options)) this.requireResponsibleMode()
    let selectedOptions = options
    if (!options.reprint) {
      const requested = uniquePrintSelection(options.selection ?? printDocumentTypes)
      const retryable = getRetryableDocuments(order.printing).filter((document) =>
        requested.includes(document),
      )
      if (!retryable.length) {
        return { ok: true, bytesWritten: 0, completedDocuments: [], warnings: [] }
      }
      selectedOptions = { ...options, selection: retryable }
    }
    const job = buildOrderPrintJob(order, selectedOptions)
    if (!job.steps.length) {
      return { ok: true, bytesWritten: 0, completedDocuments: [], warnings: [] }
    }
    return this.printer.printJob(job.steps, options.deviceId)
  }
}

export function isProtectedCustomerReprint(order: Order, options: PrintOrderOptions): boolean {
  if (!options.reprint || order.printing.customerReceipt !== 'printed') return false
  const selection = options.selection ?? printDocumentTypes
  return selection.includes('customerReceipt')
}

const orderPrintService = new OrderPrintService(new CapacitorReceiptPrinter(), () =>
  getResponsibleModeService().requireUnlocked(),
)

export function printOrderTickets(
  order: Order,
  options: PrintOrderOptions = {},
): Promise<PrintJobResult> {
  return orderPrintService.printOrder(order, options)
}
