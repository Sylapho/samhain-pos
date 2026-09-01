import { assertReceiptBusinessInfoCanBePrinted } from '../config/organization'
import { printerProfile } from '../config/printer'
import type { Order } from '../types/order'
import { CapacitorReceiptPrinter } from './capacitorReceiptPrinter'
import { renderCustomerReceipt } from './customerReceiptRenderer'
import { bytesToBase64 } from './escPos'
import { renderPreparationTicket } from './preparationTicketRenderer'
import { OrderPrintError } from './types'
import type {
  PrintDocumentType,
  PrintJobResult,
  PrintJobStep,
  PrintSelection,
  ReceiptPrinter,
  RenderedTicket,
} from './types'

export type PrintOrderOptions = {
  printCustomerReceipt?: boolean
  selection?: PrintSelection
  deviceId?: number
}

export type BuiltOrderPrintJob = {
  documents: RenderedTicket[]
  steps: PrintJobStep[]
}

function includesDocument(selection: PrintSelection, type: PrintDocumentType): boolean {
  return (
    selection === 'both' || selection === (type === 'customerReceipt' ? 'customer' : 'preparation')
  )
}

export function buildOrderPrintJob(
  order: Order,
  options: PrintOrderOptions = {},
): BuiltOrderPrintJob {
  const selection = options.selection ?? 'both'
  const documents: RenderedTicket[] = []

  if ((options.printCustomerReceipt ?? true) && includesDocument(selection, 'customerReceipt')) {
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
  if (includesDocument(selection, 'preparationTicket')) {
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

  if (!steps.length) {
    throw new OrderPrintError(
      'Aucun ticket n’a été sélectionné pour cette impression.',
      'configuration',
      'NO_PRINT_DOCUMENT_SELECTED',
    )
  }

  return { documents, steps }
}

export class OrderPrintService {
  constructor(private readonly printer: ReceiptPrinter) {}

  async printOrder(order: Order, options: PrintOrderOptions = {}): Promise<PrintJobResult> {
    const job = buildOrderPrintJob(order, options)
    return this.printer.printJob(job.steps, options.deviceId)
  }
}

const orderPrintService = new OrderPrintService(new CapacitorReceiptPrinter())

export function printOrderTickets(
  order: Order,
  options: PrintOrderOptions = {},
): Promise<PrintJobResult> {
  return orderPrintService.printOrder(order, options)
}
