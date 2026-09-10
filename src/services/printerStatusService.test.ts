import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { getPrinterStatus } from './printerStatusService'

vi.mock('../native/epsonUsbPrinter', () => ({
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(),
    getDevices: vi.fn(),
  },
}))

const printer = {
  deviceId: 1,
  deviceName: 'printer',
  vendorId: 0x04b8,
  productId: 1,
  manufacturerName: 'Epson',
  productName: 'TM-T88V',
  epson: true,
  hasPermission: true,
  hasBulkOutEndpoint: true,
}

describe('statut réel de l’imprimante', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(epsonUsbPrinter.isAndroidNative).mockReturnValue(true)
  })

  it('n’annonce pas une imprimante sur une plateforme sans intégration USB', async () => {
    vi.mocked(epsonUsbPrinter.isAndroidNative).mockReturnValue(false)

    await expect(getPrinterStatus()).resolves.toBe('unavailable')
    expect(epsonUsbPrinter.getDevices).not.toHaveBeenCalled()
  })

  it('reflète l’absence d’imprimante compatible', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [] })

    await expect(getPrinterStatus()).resolves.toBe('disconnected')
  })

  it('demande une autorisation avant de considérer l’imprimante prête', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: [{ ...printer, hasPermission: false }],
    })

    await expect(getPrinterStatus()).resolves.toBe('permission-required')
  })

  it('annonce prête uniquement après détection d’une Epson compatible et autorisée', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })

    await expect(getPrinterStatus()).resolves.toBe('ready')
  })

  it('reflète une erreur de vérification native', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockRejectedValue(new Error('Bridge indisponible'))

    await expect(getPrinterStatus()).resolves.toBe('error')
  })
})
