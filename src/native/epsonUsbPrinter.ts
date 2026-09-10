import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PrintJobResult, PrintJobStep } from '../printing/types'

export type UsbPrinterDevice = {
  deviceId: number
  deviceName: string
  vendorId: number
  productId: number
  manufacturerName: string | null
  productName: string | null
  epson: boolean
  hasPermission: boolean
  hasBulkOutEndpoint: boolean
  hasBulkInEndpoint: boolean
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

export const epsonUsbPrinter = {
  isAndroidNative() {
    return Capacitor.getPlatform() === 'android'
  },
  getDevices() {
    return nativePlugin.getDevices()
  },
  getStatus(deviceId: number) {
    return nativePlugin.getStatus({ deviceId })
  },
  requestPermission(deviceId: number) {
    return nativePlugin.requestPermission({ deviceId })
  },
  printTest(deviceId: number) {
    return nativePlugin.printTest({ deviceId })
  },
  printJob(deviceId: number, steps: PrintJobStep[]) {
    return nativePlugin.printJob({ deviceId, steps })
  },
}
