import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { printUsbTestTicket } from './printerTestService'

vi.mock('../native/epsonUsbPrinter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../native/epsonUsbPrinter')>()),
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(() => true),
    getDevices: vi.fn(),
    requestPermission: vi.fn(),
    printJob: vi.fn(),
  },
}))

const printer = {
  deviceId: 7,
  deviceName: 'printer',
  vendorId: 0x04b8,
  productId: 0x0202,
  manufacturerName: 'EPSON',
  productName: 'TM-T88V',
  epson: true,
  hasPermission: true,
  hasBulkOutEndpoint: true,
  hasBulkInEndpoint: true,
}

describe('ticket de test', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.printJob).mockResolvedValue({
      ok: true,
      bytesWritten: 84,
      completedDocuments: ['customerReceipt'],
      warnings: [],
    })
  })

  it('passe par le pipeline printJob existant avec lecture d’état et coupe natives', async () => {
    await expect(printUsbTestTicket(7)).resolves.toBe(84)

    expect(epsonUsbPrinter.printJob).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([
        expect.objectContaining({ type: 'document', documentType: 'customerReceipt' }),
        expect.objectContaining({ type: 'cut', afterDocument: 'customerReceipt' }),
      ]),
    )
  })
})
