import type { UsbPrinterDevice } from '../../native/epsonUsbPrinter'
import { getNativeErrorCode } from '../../services/printerStatusService'

export function usbDeviceLabel(device: UsbPrinterDevice): string {
  return device.productName || device.manufacturerName || 'Imprimante Epson'
}

export function printerActionError(error: unknown, duringTest = false): string {
  const code = getNativeErrorCode(error)
  if (code === 'USB_DEVICE_NOT_FOUND' || code === 'USB_PERMISSION_DEVICE_DISCONNECTED') {
    return 'Imprimante non détectée. Rebranchez-la puis appuyez sur Actualiser.'
  }
  if (code?.startsWith('USB_PERMISSION')) {
    return 'Connexion non autorisée. Appuyez sur Connecter pour réessayer.'
  }
  if (code === 'USB_OPEN_FAILED' || code === 'USB_CLAIM_FAILED') {
    return 'Impossible de se connecter à l’imprimante. Vérifiez le câble puis reconnectez-la.'
  }
  if (duringTest || code?.includes('WRITE') || code?.includes('TRANSFER')) {
    return 'L’impression de test a échoué. Vérifiez l’imprimante, le papier et le câble.'
  }
  return 'Impossible de vérifier l’imprimante. Vérifiez le câble puis réessayez.'
}
