import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter } from '../native/epsonUsbPrinter'
import { CapacitorReceiptPrinter } from './capacitorReceiptPrinter'
import { getCompletedDocumentsFromPrintError } from './orderPrintService'
import { OrderPrintError } from './types'

vi.mock('../native/epsonUsbPrinter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../native/epsonUsbPrinter')>()),
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(() => true),
    getDevices: vi.fn(),
    getStatus: vi.fn(),
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
        hasBulkInEndpoint: true,
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

  it('préserve un refus natif avant transfert lorsque le matériel n’est pas prêt', async () => {
    vi.mocked(epsonUsbPrinter.printJob).mockRejectedValue({
      code: 'USB_PRINTER_PAPER_OUT',
      message: 'L’imprimante n’a plus de papier. Remettez un rouleau puis réessayez.',
      data: { completedDocuments: [] },
    })

    await expect(new CapacitorReceiptPrinter().printJob([])).rejects.toMatchObject({
      stage: 'connection',
      causeCode: 'USB_PRINTER_PAPER_OUT',
      completedDocuments: [],
    })
  })

  it('préserve un document ambigu et la progression USB structurée', async () => {
    vi.mocked(epsonUsbPrinter.printJob).mockRejectedValue({
      code: 'USB_PREPARATION_WRITE_PARTIAL',
      message: 'Transfert interrompu',
      data: {
        completedDocuments: ['customerReceipt'],
        unknownDocuments: ['preparationTicket'],
        transfer: {
          status: 'partial',
          bytesWritten: 900,
          totalBytes: 1_600,
          failureKind: 'device_disconnected',
        },
      },
    })

    await expect(new CapacitorReceiptPrinter().printJob([])).rejects.toMatchObject({
      stage: 'preparationTicket',
      completedDocuments: ['customerReceipt'],
      unknownDocuments: ['preparationTicket'],
      transfer: {
        status: 'partial',
        bytesWritten: 900,
        totalBytes: 1_600,
        failureKind: 'device_disconnected',
      },
    })
  })

  it('ne sélectionne jamais automatiquement un périphérique non Epson', async () => {
    const { devices } = await epsonUsbPrinter.getDevices()
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: devices.map((device) => ({ ...device, epson: false })),
    })

    await expect(new CapacitorReceiptPrinter().printJob([])).rejects.toMatchObject({
      causeCode: 'USB_DEVICE_NOT_FOUND',
    })
    expect(epsonUsbPrinter.printJob).not.toHaveBeenCalled()
  })

  it('sélectionne de façon déterministe une interface Printer Class compatible', async () => {
    const { devices } = await epsonUsbPrinter.getDevices()
    const base = devices[0]!
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({
      devices: [
        {
          ...base,
          deviceId: 9,
          deviceName: 'z',
          serialNumber: 'B',
          hasPrinterClassInterface: true,
        },
        {
          ...base,
          deviceId: 4,
          deviceName: 'a',
          serialNumber: 'A',
          hasPrinterClassInterface: true,
        },
        { ...base, deviceId: 2, deviceName: '0', serialNumber: '0' },
      ],
    })
    vi.mocked(epsonUsbPrinter.printJob).mockResolvedValue({
      ok: true,
      bytesWritten: 0,
      completedDocuments: [],
      warnings: [],
    })

    await new CapacitorReceiptPrinter().printJob([])

    expect(epsonUsbPrinter.printJob).toHaveBeenCalledWith(4, [])
  })
})
