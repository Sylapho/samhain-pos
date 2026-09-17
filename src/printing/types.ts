export const printDocumentTypes = ['pickupTicket', 'customerReceipt', 'preparationTicket'] as const

export type PrintDocumentType = (typeof printDocumentTypes)[number]
export type PrintSelection = readonly PrintDocumentType[]

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

export type UsbTransferProgress = {
  status: 'complete' | 'no_bytes_sent' | 'partial'
  bytesWritten: number
  totalBytes: number
  failureKind?: 'device_disconnected' | 'transport_error'
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
      | 'pickupTicket'
      | 'pickupCut'
      | 'customerReceipt'
      | 'customerCut'
      | 'preparationTicket'
      | 'preparationCut',
    public readonly causeCode?: string,
    public readonly completedDocuments?: PrintDocumentType[],
    public readonly unknownDocuments?: PrintDocumentType[],
    public readonly transfer?: UsbTransferProgress,
  ) {
    super(message)
    this.name = 'OrderPrintError'
  }
}
