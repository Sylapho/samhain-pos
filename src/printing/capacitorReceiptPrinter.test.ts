import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { CapacitorReceiptPrinter } from './capacitorReceiptPrinter'
import { getCompletedDocumentsFromPrintError } from './orderPrintService'
import { OrderPrintError } from './types'

vi.mock('../native/epsonUsbPrinter', () => ({
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(() => true),
    getDevices: vi.fn(),
    requestPermission: vi.fn(),
    printJob: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
    devices: [
      {
        deviceId: 1,
        deviceName: 'printer',
        vendorId: 1,
        productId: 1,
        manufacturerName: null,
        productName: null,
        epson: true,
        hasPermission: true,
        hasBulkOutEndpoint: true,
      },
    ],
  })
})

describe('progression des erreurs natives', () => {
  it.each([
    ['USB_PREPARATION_WRITE_FAILED', ['customerReceipt']],
    ['USB_PRINT_ERROR', ['customerReceipt']],
    ['USB_PRINT_JOB_INVALID', ['customerReceipt']],
    ['USB_CUSTOMER_CUT_FAILED', ['customerReceipt']],
    ['USB_PREPARATION_CUT_FAILED', ['customerReceipt', 'preparationTicket']],
    ['USB_PREPARATION_WRITE_FAILED', []],
  ])('préserve les documents transmis avec %s (%j)', async (code, completedDocuments) => {
    vi.mocked(epsonUsbPrinter.printJob).mockRejectedValue({
      code,
      message: 'Interruption',
      data: { completedDocuments },
    })
    const error = await new CapacitorReceiptPrinter().printJob([]).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(OrderPrintError)
    expect(getCompletedDocumentsFromPrintError(error)).toEqual(completedDocuments)
  })

  it('accepte un ancien plugin sans inventer de ticket client si seule la préparation était demandée', async () => {
    vi.mocked(epsonUsbPrinter.printJob).mockRejectedValue({
      code: 'USB_PREPARATION_CUT_FAILED',
      message: 'Coupe échouée',
    })
    const error = await new CapacitorReceiptPrinter().printJob([]).catch((error: unknown) => error)
    expect(getCompletedDocumentsFromPrintError(error, { selection: 'preparation' })).toEqual([
      'preparationTicket',
    ])
  })

  it('propage le refus de permission sans lancer de transfert', async () => {
    const { devices } = await epsonUsbPrinter.getDevices()
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: devices.map((device) => ({ ...device, hasPermission: false })),
    })
    vi.mocked(epsonUsbPrinter.requestPermission).mockResolvedValue({
      granted: false,
      device: devices[0]!,
    })
    await expect(new CapacitorReceiptPrinter().printJob([])).rejects.toMatchObject({
      stage: 'permission',
      causeCode: 'USB_PERMISSION_DENIED',
    })
    expect(epsonUsbPrinter.printJob).not.toHaveBeenCalled()
  })
})
