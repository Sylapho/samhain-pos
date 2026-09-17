import { selectCompatibleEpsonPrinter, type UsbPrinterDevice } from '../native/epsonUsbPrinter'

const PREFERRED_PRINTER_KEY = 'samhain-pos.preferred-usb-printer.v1'

export type PreferredUsbPrinter = {
  vendorId: number
  productId: number
  deviceName: string
  manufacturerName: string | null
  productName: string | null
  serialNumber: string | null
}

export function getPreferredUsbPrinter(
  storage: Pick<Storage, 'getItem'> | null = getLocalStorage(),
): PreferredUsbPrinter | null {
  if (!storage) return null

  try {
    const value = storage.getItem(PREFERRED_PRINTER_KEY)
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    return isPreferredUsbPrinter(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function savePreferredUsbPrinter(
  device: UsbPrinterDevice,
  storage: Pick<Storage, 'setItem'> | null = getLocalStorage(),
): PreferredUsbPrinter {
  const preferred: PreferredUsbPrinter = {
    vendorId: device.vendorId,
    productId: device.productId,
    deviceName: device.deviceName,
    manufacturerName: device.manufacturerName,
    productName: device.productName,
    serialNumber: device.serialNumber ?? null,
  }
  try {
    storage?.setItem(PREFERRED_PRINTER_KEY, JSON.stringify(preferred))
  } catch {
    // La sélection reste utilisable pour la session si le stockage local est indisponible.
  }
  return preferred
}

export function selectConfiguredUsbPrinter(
  devices: UsbPrinterDevice[],
  preferred: PreferredUsbPrinter | null = getPreferredUsbPrinter(),
): UsbPrinterDevice | undefined {
  const compatible = devices.filter((device) => device.epson && device.hasBulkOutEndpoint)
  if (!preferred) return selectCompatibleEpsonPrinter(compatible)

  if (preferred.serialNumber) {
    const serialMatch = compatible.find(
      (device) =>
        device.vendorId === preferred.vendorId &&
        device.productId === preferred.productId &&
        device.serialNumber === preferred.serialNumber,
    )
    if (serialMatch) return serialMatch
  }

  const pathMatch = compatible.find(
    (device) =>
      device.vendorId === preferred.vendorId &&
      device.productId === preferred.productId &&
      device.deviceName === preferred.deviceName,
  )
  if (pathMatch) return pathMatch

  const modelMatches = compatible.filter(
    (device) =>
      device.vendorId === preferred.vendorId &&
      device.productId === preferred.productId &&
      (preferred.productName === null || device.productName === preferred.productName),
  )
  return modelMatches.length === 1 ? modelMatches[0] : undefined
}

export function preferredPrinterLabel(preferred: PreferredUsbPrinter): string {
  return preferred.productName || preferred.manufacturerName || 'Imprimante Epson USB'
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function isPreferredUsbPrinter(value: unknown): value is PreferredUsbPrinter {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PreferredUsbPrinter>
  return (
    Number.isSafeInteger(candidate.vendorId) &&
    Number.isSafeInteger(candidate.productId) &&
    typeof candidate.deviceName === 'string' &&
    (candidate.manufacturerName === null || typeof candidate.manufacturerName === 'string') &&
    (candidate.productName === null || typeof candidate.productName === 'string') &&
    (candidate.serialNumber === null || typeof candidate.serialNumber === 'string')
  )
}
