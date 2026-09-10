import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import type { PrinterStatus } from '../types/system'

export async function getPrinterStatus(): Promise<PrinterStatus> {
  if (!epsonUsbPrinter.isAndroidNative()) return 'unavailable'

  try {
    const { devices } = await epsonUsbPrinter.getDevices()
    const printer = devices.find((device) => device.epson && device.hasBulkOutEndpoint)

    if (!printer) return 'disconnected'
    return printer.hasPermission ? 'ready' : 'permission-required'
  } catch {
    return 'error'
  }
}
