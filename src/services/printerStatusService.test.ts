import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { getPrinterStatus } from './printerStatusService'

vi.mock('../native/epsonUsbPrinter', () => ({
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(),
    getDevices: vi.fn(),
    getStatus: vi.fn(),
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
  hasBulkInEndpoint: true,
}

const readyHardwareStatus = {
  connected: true,
  online: true,
  paperOut: false,
  paperNearEnd: false,
  coverOpen: false,
  error: false,
  cutterError: false,
  recoverableError: false,
  unrecoverableError: false,
  autoRecoverableError: false,
  raw: { offline: 0x12, error: 0x12, paper: 0x12 },
}

describe('statut réel de l’imprimante', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(epsonUsbPrinter.isAndroidNative).mockReturnValue(true)
    vi.mocked(epsonUsbPrinter.getStatus).mockResolvedValue(readyHardwareStatus)
  })

  it('n’annonce pas une imprimante sur une plateforme sans intégration USB', async () => {
    vi.mocked(epsonUsbPrinter.isAndroidNative).mockReturnValue(false)

    await expect(getPrinterStatus()).resolves.toBe('unavailable')
    expect(epsonUsbPrinter.getDevices).not.toHaveBeenCalled()
  })

  it('reflète l’absence d’imprimante compatible', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: [{ ...printer, epson: false, manufacturerName: 'Autre USB' }],
    })

    await expect(getPrinterStatus()).resolves.toBe('disconnected')
  })

  it('demande une autorisation avant d’interroger l’imprimante', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: [{ ...printer, hasPermission: false }],
    })

    await expect(getPrinterStatus()).resolves.toBe('permission-required')
    expect(epsonUsbPrinter.getStatus).not.toHaveBeenCalled()
  })

  it('annonce prête uniquement après une réponse matérielle sans anomalie', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })

    await expect(getPrinterStatus()).resolves.toBe('ready')
    expect(epsonUsbPrinter.getStatus).toHaveBeenCalledWith(printer.deviceId)
  })

  it('reflète un papier épuisé retourné par la TM-T88V', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockResolvedValue({
      ...readyHardwareStatus,
      online: false,
      paperOut: true,
      raw: { ...readyHardwareStatus.raw, offline: 0x32, paper: 0x72 },
    })

    await expect(getPrinterStatus()).resolves.toBe('paper-out')
  })

  it('donne la priorité au capot ouvert si la valeur papier est également active', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockResolvedValue({
      ...readyHardwareStatus,
      online: false,
      coverOpen: true,
      paperOut: true,
      raw: { ...readyHardwareStatus.raw, offline: 0x36, paper: 0x72 },
    })

    await expect(getPrinterStatus()).resolves.toBe('cover-open')
  })

  it.each([
    { error: true },
    { cutterError: true },
    { recoverableError: true },
    { unrecoverableError: true },
    { autoRecoverableError: true },
    { online: false },
  ])('reflète une anomalie matérielle', async (hardwareChange) => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockResolvedValue({
      ...readyHardwareStatus,
      ...hardwareChange,
    })

    await expect(getPrinterStatus()).resolves.toBe('error')
  })

  it('ne considère pas une interface sans BULK IN comme prête', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: [{ ...printer, hasBulkInEndpoint: false }],
    })

    await expect(getPrinterStatus()).resolves.toBe('status-unavailable')
    expect(epsonUsbPrinter.getStatus).not.toHaveBeenCalled()
  })

  it('distingue une interrogation native impossible d’une erreur signalée par l’imprimante', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockRejectedValue(new Error('Bridge indisponible'))

    await expect(getPrinterStatus()).resolves.toBe('status-unavailable')
  })

  it('ne retourne jamais prête lorsque l’imprimante ne répond pas', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockRejectedValue({
      code: 'USB_STATUS_NO_RESPONSE',
      message: 'Aucune réponse',
    })

    await expect(getPrinterStatus()).resolves.toBe('status-unavailable')
  })

  it('reflète un débranchement survenu pendant la lecture', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockRejectedValue({ code: 'USB_DEVICE_NOT_FOUND' })

    await expect(getPrinterStatus()).resolves.toBe('disconnected')
  })
})
