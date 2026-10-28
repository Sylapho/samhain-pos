import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PrintJobResult, PrintJobStep } from '../printing/types'

export type UsbPrinterDevice = {
  deviceId: number
  deviceName: string
  vendorId: number
  productId: number
  manufacturerName: string | null
  productName: string | null
  /** Unavailable until Android has granted USB permission on some devices. */
  serialNumber?: string | null
  epson: boolean
  hasPermission: boolean
  hasBulkOutEndpoint: boolean
  hasBulkInEndpoint: boolean
  hasPrinterClassInterface?: boolean
}

export type EpsonPrinterHardwareStatus = {
  connected: boolean
  online: boolean
  paperOut: boolean
  paperNearEnd: boolean
  coverOpen: boolean
  error: boolean
  cutterError: boolean
  recoverableError: boolean
  unrecoverableError: boolean
  autoRecoverableError: boolean
  raw: {
    offline: number
    error: number
    paper: number
  }
}

export function selectCompatibleEpsonPrinter(
  devices: UsbPrinterDevice[],
): UsbPrinterDevice | undefined {
  return devices
    .filter((device) => device.epson && device.hasBulkOutEndpoint)
    .sort((left, right) => {
      const printerClassOrder =
        Number(Boolean(right.hasPrinterClassInterface)) -
        Number(Boolean(left.hasPrinterClassInterface))
      if (printerClassOrder !== 0) return printerClassOrder
      const serialAvailabilityOrder =
        Number(Boolean(right.serialNumber)) - Number(Boolean(left.serialNumber))
      if (serialAvailabilityOrder !== 0) return serialAvailabilityOrder
      const leftIdentity = [
        left.vendorId,
        left.productId,
        left.serialNumber ?? '',
        left.productName ?? '',
        left.deviceName,
      ].join(':')
      const rightIdentity = [
        right.vendorId,
        right.productId,
        right.serialNumber ?? '',
        right.productName ?? '',
        right.deviceName,
      ].join(':')
      return leftIdentity.localeCompare(rightIdentity) || left.deviceId - right.deviceId
    })[0]
}

type DeviceListResult = {
  devices: UsbPrinterDevice[]
}

type PermissionResult = {
  granted: boolean
  device: UsbPrinterDevice
}

type PrintResult = {
  ok: boolean
  bytesWritten: number
  device: UsbPrinterDevice
}

interface EpsonUsbPrinterPlugin {
  getDevices(): Promise<DeviceListResult>
  getStatus(options: { deviceId: number }): Promise<EpsonPrinterHardwareStatus>
  requestPermission(options: { deviceId: number }): Promise<PermissionResult>
  printTest(options: { deviceId: number }): Promise<PrintResult>
  printJob(options: { deviceId: number; steps: PrintJobStep[] }): Promise<PrintJobResult>
}

const nativePlugin = registerPlugin<EpsonUsbPrinterPlugin>('EpsonUsbPrinter')

let pendingPrints = 0
let statusRead: { deviceId: number; result: Promise<EpsonPrinterHardwareStatus> } | null = null
const printListeners = new Set<() => void>()
const printerBusyError = () =>
  Object.assign(new Error('Impression en cours'), { code: 'USB_PRINTER_BUSY' })

export const isUsbPrinting = () => pendingPrints > 0
export function subscribeUsbPrinting(listener: () => void) {
  printListeners.add(listener)
  return () => {
    printListeners.delete(listener)
  }
}

async function withPrintPriority<T>(print: () => Promise<T>): Promise<T> {
  pendingPrints += 1
  printListeners.forEach((listener) => listener())
  try {
    // An already started probe finishes before printing; no new probe can enter.
    await statusRead?.result.catch(() => undefined)
    return await print()
  } finally {
    pendingPrints -= 1
    printListeners.forEach((listener) => listener())
  }
}

export const epsonUsbPrinter = {
  isAndroidNative() {
    return Capacitor.getPlatform() === 'android'
  },
  getDevices() {
    return nativePlugin.getDevices()
  },
  getStatus(deviceId: number) {
    if (pendingPrints > 0) {
      return Promise.reject(printerBusyError())
    }
    if (statusRead) {
      if (statusRead.deviceId === deviceId) return statusRead.result
      return Promise.reject(
        Object.assign(new Error('Vérification en cours'), { code: 'USB_STATUS_BUSY' }),
      )
    }
    const result = nativePlugin
      .getStatus({ deviceId })
      .then((status) => {
        // A print requested during the read supersedes this observation in every consumer.
        if (pendingPrints > 0) throw printerBusyError()
        return status
      })
      .finally(() => {
        statusRead = null
      })
    statusRead = { deviceId, result }
    return result
  },
  requestPermission(deviceId: number) {
    return nativePlugin.requestPermission({ deviceId })
  },
  printTest(deviceId: number) {
    return withPrintPriority(() => nativePlugin.printTest({ deviceId }))
  },
  printJob(deviceId: number, steps: PrintJobStep[]) {
    return withPrintPriority(() => nativePlugin.printJob({ deviceId, steps }))
  },
}
