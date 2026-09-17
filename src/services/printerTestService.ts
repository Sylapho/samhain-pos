import { printerProfile } from '../config/printer'
import { CapacitorReceiptPrinter } from '../printing/capacitorReceiptPrinter'
import { bytesToBase64, EscPosBuilder } from '../printing/escPos'
import type { PrintJobStep } from '../printing/types'

export async function printUsbTestTicket(deviceId: number): Promise<number> {
  const ticket = new EscPosBuilder()
    .initialize(printerProfile.codePage)
    .align('center')
    .bold(true)
    .doubleSize(true)
    .line('SAMHAIN POS')
    .doubleSize(false)
    .line('Test imprimante')
    .bold(false)
    .blank()
    .line('Imprimante prete')
    .line(new Date().toLocaleString('fr-FR'))
    .build('customerReceipt')

  const steps: PrintJobStep[] = [
    {
      type: 'document',
      documentType: ticket.type,
      dataBase64: bytesToBase64(ticket.bytes),
    },
    {
      type: 'cut',
      afterDocument: ticket.type,
      feedLines: printerProfile.feedLinesBeforeCut,
      cutMode: printerProfile.cutMode,
    },
  ]
  const result = await new CapacitorReceiptPrinter().printJob(steps, deviceId)
  return result.bytesWritten
}
