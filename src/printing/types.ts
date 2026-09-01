export type PrintDocumentType = 'customerReceipt' | 'preparationTicket'
export type PrintSelection = 'both' | 'customer' | 'preparation'

export type RenderedTicket = {
  type: PrintDocumentType
  preview: string
  bytes: Uint8Array
}

export type PrintJobStep =
  | {
      type: 'document'
      documentType: PrintDocumentType
      dataBase64: string
    }
  | {
      type: 'cut'
      afterDocument: PrintDocumentType
      feedLines: number
      cutMode: 'full'
    }

export type PrintJobResult = {
  ok: true
  bytesWritten: number
  completedDocuments: PrintDocumentType[]
  warnings: string[]
}

export interface ReceiptPrinter {
  printJob(steps: PrintJobStep[], deviceId?: number): Promise<PrintJobResult>
}

export class OrderPrintError extends Error {
  constructor(
    message: string,
    public readonly stage:
      | 'configuration'
      | 'connection'
      | 'permission'
      | 'customerReceipt'
      | 'customerCut'
      | 'preparationTicket'
      | 'preparationCut',
    public readonly causeCode?: string,
  ) {
    super(message)
    this.name = 'OrderPrintError'
  }
}
