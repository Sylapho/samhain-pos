import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import type { PrinterStatus } from '../types/system'

export async function getPrinterStatus(): Promise<PrinterStatus> {
  if (!epsonUsbPrinter.isAndroidNative()) return 'unavailable'

  try {
    const { devices } = await epsonUsbPrinter.getDevices()
    const printer = devices.find((device) => device.epson && device.hasBulkOutEndpoint)

    if (!printer) return 'disconnected'
    if (!printer.hasPermission) return 'permission-required'
    if (!printer.hasBulkInEndpoint) return 'status-unavailable'

    const hardwareStatus = await epsonUsbPrinter.getStatus(printer.deviceId)
    if (hardwareStatus.coverOpen) return 'cover-open'
    if (hardwareStatus.paperOut) return 'paper-out'
    if (
      hardwareStatus.error ||
      hardwareStatus.cutterError ||
      hardwareStatus.recoverableError ||
      hardwareStatus.unrecoverableError ||
      hardwareStatus.autoRecoverableError ||
      !hardwareStatus.online
    ) {
      return 'error'
    }

    return 'ready'
  } catch (error) {
    const code = getNativeErrorCode(error)
    if (code === 'USB_DEVICE_NOT_FOUND') return 'disconnected'
    if (code?.startsWith('USB_PERMISSION')) return 'permission-required'
    return 'status-unavailable'
  }
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
