import {
  epsonUsbPrinter,
  type EpsonPrinterHardwareStatus,
  type UsbPrinterDevice,
} from '../native/epsonUsbPrinter'
import type { PrinterStatus } from '../types/system'
import { selectConfiguredUsbPrinter } from './printerSelectionService'

export async function getPrinterStatus(): Promise<PrinterStatus> {
  if (!epsonUsbPrinter.isAndroidNative()) return 'unavailable'

  try {
    const { devices } = await epsonUsbPrinter.getDevices()
    const printer = selectConfiguredUsbPrinter(devices)

    if (!printer) return 'disconnected'
    return await getPrinterStatusForDevice(printer)
  } catch (error) {
    return printerStatusFromError(error)
  }
}

export async function getPrinterStatusForDevice(printer: UsbPrinterDevice): Promise<PrinterStatus> {
  if (!printer.hasPermission) return 'permission-required'
  if (!printer.hasBulkInEndpoint) return 'status-unavailable'

  try {
    return printerStatusFromHardware(await epsonUsbPrinter.getStatus(printer.deviceId))
  } catch (error) {
    return printerStatusFromError(error)
  }
}

export function printerStatusFromHardware(status: EpsonPrinterHardwareStatus): PrinterStatus {
  if (!status.connected) return 'disconnected'
  if (status.coverOpen) return 'cover-open'
  if (status.paperOut) return 'paper-out'
  if (
    status.error ||
    status.cutterError ||
    status.recoverableError ||
    status.unrecoverableError ||
    status.autoRecoverableError ||
    !status.online
  ) {
    return 'error'
  }
  return 'ready'
}

export function printerStatusFromError(error: unknown): PrinterStatus {
  const code = getNativeErrorCode(error)
  if (code === 'USB_DEVICE_NOT_FOUND') return 'disconnected'
  if (code?.startsWith('USB_PERMISSION')) return 'permission-required'
  return 'status-unavailable'
}

export function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  if ('causeCode' in error && typeof error.causeCode === 'string') return error.causeCode
  return undefined
}
