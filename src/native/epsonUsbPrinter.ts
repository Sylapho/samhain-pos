import { Capacitor, registerPlugin } from '@capacitor/core'

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
  requestPermission(options: { deviceId: number }): Promise<PermissionResult>
  printTest(options: { deviceId: number }): Promise<PrintResult>
}

const nativePlugin = registerPlugin<EpsonUsbPrinterPlugin>('EpsonUsbPrinter')

export const epsonUsbPrinter = {
  isAndroidNative() {
    return Capacitor.getPlatform() === 'android'
  },
  getDevices() {
    return nativePlugin.getDevices()
  },
  requestPermission(deviceId: number) {
    return nativePlugin.requestPermission({ deviceId })
  },
  printTest(deviceId: number) {
    return nativePlugin.printTest({ deviceId })
  },
}
