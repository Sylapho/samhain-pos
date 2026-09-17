import { epsonUsbPrinter, selectCompatibleEpsonPrinter } from '../native/epsonUsbPrinter'
import {
  OrderPrintError,
  type PrintDocumentType,
  type PrintJobStep,
  type ReceiptPrinter,
  type UsbTransferProgress,
} from './types'

type NativeError = Error & {
  code?: string
  data?: {
    completedDocuments?: unknown
    unknownDocuments?: unknown
    transfer?: unknown
  }
}

function parseDocuments(value: unknown): PrintDocumentType[] | undefined {
  return Array.isArray(value)
    ? value.filter(
        (document): document is PrintDocumentType =>
          document === 'pickupTicket' ||
          document === 'customerReceipt' ||
          document === 'preparationTicket',
      )
    : undefined
}

function parseTransfer(value: unknown): UsbTransferProgress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const transfer = value as Partial<UsbTransferProgress>
  const bytesWritten = transfer.bytesWritten
  const totalBytes = transfer.totalBytes
  if (
    !['complete', 'no_bytes_sent', 'partial'].includes(transfer.status ?? '') ||
    typeof bytesWritten !== 'number' ||
    typeof totalBytes !== 'number' ||
    !Number.isSafeInteger(bytesWritten) ||
    !Number.isSafeInteger(totalBytes) ||
    bytesWritten < 0 ||
    totalBytes < 0 ||
    bytesWritten > totalBytes
  ) {
    return undefined
  }
  const progressMatchesStatus =
    (transfer.status === 'complete' && bytesWritten === totalBytes) ||
    (transfer.status === 'no_bytes_sent' && bytesWritten === 0) ||
    (transfer.status === 'partial' && bytesWritten > 0 && bytesWritten < totalBytes)
  if (!progressMatchesStatus) return undefined
  if (
    transfer.failureKind !== undefined &&
    !['device_disconnected', 'transport_error'].includes(transfer.failureKind)
  ) {
    return undefined
  }
  return transfer as UsbTransferProgress
}

function mapNativeError(error: unknown): OrderPrintError {
  if (error instanceof OrderPrintError) return error

  const nativeError = error as NativeError
  const code = nativeError?.code ?? 'USB_PRINT_ERROR'
  const nativeMessage = nativeError?.message ?? 'Erreur USB inconnue.'
  const completedDocuments = parseDocuments(nativeError?.data?.completedDocuments)
  const unknownDocuments = parseDocuments(nativeError?.data?.unknownDocuments)
  const transfer = parseTransfer(nativeError?.data?.transfer)

  if (code.startsWith('USB_PICKUP_WRITE')) {
    return new OrderPrintError(
      `${unknownDocuments?.includes('pickupTicket') ? 'L’état du bon de retrait est incertain ; vérifiez le papier avant toute réimpression.' : 'Le bon de retrait n’a pas pu être imprimé.'} ${nativeMessage}`,
      'pickupTicket',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PICKUP_CUT')) {
    return new OrderPrintError(
      `Le bon de retrait est imprimé, mais sa coupe a échoué. ${nativeMessage}`,
      'pickupCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_CUSTOMER_RECEIPT')) {
    return new OrderPrintError(
      `${unknownDocuments?.includes('customerReceipt') ? 'L’état du ticket client est incertain ; vérifiez le papier avant toute réimpression.' : 'Le ticket client n’a pas pu être imprimé.'} ${nativeMessage}`,
      'customerReceipt',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_CUSTOMER_CUT')) {
    return new OrderPrintError(
      `Le ticket client est imprimé, mais sa coupe a échoué. ${nativeMessage}`,
      'customerCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PREPARATION_WRITE')) {
    return new OrderPrintError(
      `${unknownDocuments?.includes('preparationTicket') ? 'L’état du ticket de préparation est incertain ; vérifiez le papier avant toute réimpression.' : 'Le ticket de préparation n’a pas pu être imprimé.'} ${nativeMessage}`,
      'preparationTicket',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PREPARATION_CUT')) {
    return new OrderPrintError(
      `La coupe du ticket de préparation a échoué. ${nativeMessage}`,
      'preparationCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PERMISSION')) {
    return new OrderPrintError(
      nativeMessage,
      'permission',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }

  return new OrderPrintError(
    nativeMessage,
    'connection',
    code,
    completedDocuments,
    unknownDocuments,
    transfer,
  )
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
      const device =
        requestedDeviceId !== undefined
          ? devices.find(
              (candidate) =>
                candidate.deviceId === requestedDeviceId &&
                candidate.epson &&
                candidate.hasBulkOutEndpoint,
            )
          : selectCompatibleEpsonPrinter(devices)

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
