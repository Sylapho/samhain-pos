import { epsonUsbPrinter, type UsbPrinterDevice } from '../native/epsonUsbPrinter'
import { OrderPrintError, type PrintJobStep, type ReceiptPrinter } from './types'

type NativeError = Error & { code?: string }

function selectPrinter(devices: UsbPrinterDevice[]): UsbPrinterDevice | undefined {
  return (
    devices.find((device) => device.epson && device.hasBulkOutEndpoint) ??
    devices.find((device) => device.hasBulkOutEndpoint)
  )
}

function mapNativeError(error: unknown): OrderPrintError {
  if (error instanceof OrderPrintError) return error

  const nativeError = error as NativeError
  const code = nativeError?.code ?? 'USB_PRINT_ERROR'
  const nativeMessage = nativeError?.message ?? 'Erreur USB inconnue.'

  if (code.startsWith('USB_CUSTOMER_RECEIPT')) {
    return new OrderPrintError(
      `Le ticket client n’a pas pu être imprimé. ${nativeMessage}`,
      'customerReceipt',
      code,
    )
  }
  if (code.startsWith('USB_CUSTOMER_CUT')) {
    return new OrderPrintError(
      `Le ticket client est imprimé, mais sa coupe a échoué. ${nativeMessage}`,
      'customerCut',
      code,
    )
  }
  if (code.startsWith('USB_PREPARATION_WRITE')) {
    return new OrderPrintError(
      `Le ticket de préparation n’a pas pu être imprimé. ${nativeMessage}`,
      'preparationTicket',
      code,
    )
  }
  if (code.startsWith('USB_PREPARATION_CUT')) {
    return new OrderPrintError(
      `La coupe du ticket de préparation a échoué. ${nativeMessage}`,
      'preparationCut',
      code,
    )
  }
  if (code.startsWith('USB_PERMISSION')) {
    return new OrderPrintError(nativeMessage, 'permission', code)
  }

  return new OrderPrintError(nativeMessage, 'connection', code)
}

export class CapacitorReceiptPrinter implements ReceiptPrinter {
  async printJob(steps: PrintJobStep[], requestedDeviceId?: number) {
    if (!epsonUsbPrinter.isAndroidNative()) {
      throw new OrderPrintError(
        'L’impression USB est disponible uniquement dans l’application Android.',
        'connection',
        'ANDROID_REQUIRED',
      )
    }

    try {
      const { devices } = await epsonUsbPrinter.getDevices()
      const device = requestedDeviceId
        ? devices.find((candidate) => candidate.deviceId === requestedDeviceId)
        : selectPrinter(devices)

      if (!device) {
        throw new OrderPrintError(
          'Aucune imprimante USB compatible n’est connectée.',
          'connection',
          'USB_DEVICE_NOT_FOUND',
        )
      }

      if (!device.hasPermission) {
        const permission = await epsonUsbPrinter.requestPermission(device.deviceId)
        if (!permission.granted) {
          throw new OrderPrintError(
            'Autorisation USB refusée. Autorisez l’imprimante puis réessayez.',
            'permission',
            'USB_PERMISSION_DENIED',
          )
        }
      }

      return await epsonUsbPrinter.printJob(device.deviceId, steps)
    } catch (error) {
      throw mapNativeError(error)
    }
  }
}
