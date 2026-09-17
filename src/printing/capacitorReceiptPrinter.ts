import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { selectConfiguredUsbPrinter } from '../services/printerSelectionService'
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
  const completedDocuments = parseDocuments(nativeError?.data?.completedDocuments)
  const unknownDocuments = parseDocuments(nativeError?.data?.unknownDocuments)
  const transfer = parseTransfer(nativeError?.data?.transfer)

  if (code.startsWith('USB_PICKUP_WRITE')) {
    return new OrderPrintError(
      unknownDocuments?.includes('pickupTicket')
        ? 'L’état du bon de retrait est incertain. Vérifiez les tickets sortis avant toute réimpression.'
        : 'Le bon de retrait n’a pas pu être imprimé. Vérifiez l’imprimante puis réessayez.',
      'pickupTicket',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PICKUP_CUT')) {
    return new OrderPrintError(
      'Le bon de retrait est imprimé, mais la coupe a échoué. Détachez-le manuellement.',
      'pickupCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_CUSTOMER_RECEIPT')) {
    return new OrderPrintError(
      unknownDocuments?.includes('customerReceipt')
        ? 'L’état du reçu de caisse est incertain. Vérifiez les tickets sortis avant toute réimpression.'
        : 'Le reçu de caisse n’a pas pu être imprimé. Vérifiez l’imprimante puis réessayez.',
      'customerReceipt',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_CUSTOMER_CUT')) {
    return new OrderPrintError(
      'Le reçu de caisse est imprimé, mais la coupe a échoué. Détachez-le manuellement.',
      'customerCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PREPARATION_WRITE')) {
    return new OrderPrintError(
      unknownDocuments?.includes('preparationTicket')
        ? 'L’état du ticket de préparation est incertain. Vérifiez les tickets sortis avant toute réimpression.'
        : 'Le ticket de préparation n’a pas pu être imprimé. Vérifiez l’imprimante puis réessayez.',
      'preparationTicket',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PREPARATION_CUT')) {
    return new OrderPrintError(
      'Le ticket de préparation est imprimé, mais la coupe a échoué. Détachez-le manuellement.',
      'preparationCut',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }
  if (code.startsWith('USB_PERMISSION')) {
    return new OrderPrintError(
      'La connexion à l’imprimante n’est pas autorisée. Ouvrez les paramètres de l’imprimante puis réessayez.',
      'permission',
      code,
      completedDocuments,
      unknownDocuments,
      transfer,
    )
  }

  const message =
    code === 'USB_PRINTER_PAPER_OUT'
      ? 'L’imprimante n’a plus de papier. Remettez un rouleau puis réessayez.'
      : code === 'USB_PRINTER_COVER_OPEN'
        ? 'Le capot de l’imprimante est ouvert. Fermez-le puis réessayez.'
        : code === 'USB_DEVICE_NOT_FOUND'
          ? 'Imprimante non détectée. Vérifiez qu’elle est allumée et correctement branchée.'
          : 'Impossible de communiquer avec l’imprimante. Vérifiez-la puis réessayez.'

  return new OrderPrintError(
    message,
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
        'L’impression est disponible uniquement depuis l’application installée sur la tablette.',
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
          : selectConfiguredUsbPrinter(devices)

      if (!device) {
        throw new OrderPrintError(
          'Imprimante non détectée. Vérifiez qu’elle est allumée et correctement branchée.',
          'connection',
          'USB_DEVICE_NOT_FOUND',
        )
      }

      if (!device.hasPermission) {
        const permission = await epsonUsbPrinter.requestPermission(device.deviceId)
        if (!permission.granted) {
          throw new OrderPrintError(
            'Connexion à l’imprimante refusée. Ouvrez les paramètres de l’imprimante puis réessayez.',
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
