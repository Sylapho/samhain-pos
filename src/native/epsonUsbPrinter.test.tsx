import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter, isUsbPrinting } from './epsonUsbPrinter'
import { getPrinterStatusForDevice } from '../services/printerStatusService'
import { usePrinterStatus } from '../features/status/usePrinterStatus'

const native = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getDevices: vi.fn(),
  printJob: vi.fn(),
  printTest: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  registerPlugin: () => native,
}))

const device = {
  deviceId: 1,
  deviceName: 'printer',
  vendorId: 0x04b8,
  productId: 1,
  manufacturerName: 'Epson',
  productName: 'TM-T88V',
  epson: true,
  hasPermission: true,
  hasBulkInEndpoint: true,
  hasBulkOutEndpoint: true,
}
const ready = {
  connected: true,
  online: true,
  coverOpen: false,
  paperOut: false,
  paperNearEnd: false,
  error: false,
  cutterError: false,
  recoverableError: false,
  unrecoverableError: false,
  autoRecoverableError: false,
  raw: { offline: 0x12, error: 0x12, paper: 0x12 },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('coordination du pont USB', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    native.getStatus.mockResolvedValue(ready)
    native.printJob.mockResolvedValue({})
    native.printTest.mockResolvedValue({})
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each(['printJob', 'printTest'] as const)(
    'ignore les sondes tant que %s est actif',
    async (method) => {
      const done = deferred<never>()
      native[method].mockReturnValue(done.promise)
      const printing =
        method === 'printJob' ? epsonUsbPrinter.printJob(1, []) : epsonUsbPrinter.printTest(1)
      expect(isUsbPrinting()).toBe(true)
      await expect(getPrinterStatusForDevice(device)).resolves.toBe('printing')
      expect(native.getStatus).not.toHaveBeenCalled()
      done.reject({ code: 'USB_TRANSFER_PARTIAL' })
      await expect(printing).rejects.toEqual({ code: 'USB_TRANSFER_PARTIAL' })
      expect(isUsbPrinting()).toBe(false)
      await expect(getPrinterStatusForDevice(device)).resolves.toBe('ready')
      expect(native[method]).toHaveBeenCalledTimes(1)
    },
  )

  it('partage une lecture concurrente et refuse une seconde interface', async () => {
    const done = deferred<typeof ready>()
    native.getStatus.mockReturnValue(done.promise)
    const first = epsonUsbPrinter.getStatus(1)
    const second = epsonUsbPrinter.getStatus(1)
    expect(first).toBe(second)
    await expect(epsonUsbPrinter.getStatus(2)).rejects.toMatchObject({ code: 'USB_STATUS_BUSY' })
    expect(native.getStatus).toHaveBeenCalledTimes(1)
    done.resolve(ready)
    await first
  })

  it('ne publie pas prête lorsqu’une impression a été demandée pendant la lecture', async () => {
    const done = deferred<typeof ready>()
    native.getStatus.mockReturnValueOnce(done.promise)
    const reading = getPrinterStatusForDevice(device)
    const printing = epsonUsbPrinter.printJob(1, [])
    expect(native.printJob).not.toHaveBeenCalled()
    done.resolve(ready)
    await expect(reading).resolves.toBe('printing')
    await printing
    expect(native.printJob).toHaveBeenCalledTimes(1)
    expect(isUsbPrinting()).toBe(false)
  })

  it('termine la sonde déjà engagée puis donne priorité à l’impression, même si la sonde échoue', async () => {
    const status = deferred<typeof ready>()
    const job = deferred<never>()
    native.getStatus.mockReturnValueOnce(status.promise)
    native.printJob.mockReturnValue(job.promise)
    const reading = epsonUsbPrinter.getStatus(1)
    const printing = epsonUsbPrinter.printJob(1, [])
    expect(native.printJob).not.toHaveBeenCalled()
    await expect(epsonUsbPrinter.getStatus(1)).rejects.toMatchObject({ code: 'USB_PRINTER_BUSY' })
    status.reject(new Error('USB'))
    await expect(reading).rejects.toThrow('USB')
    await Promise.resolve()
    expect(native.printJob).toHaveBeenCalledTimes(1)
    job.reject({
      code: 'USB_PREPARATION_WRITE_PARTIAL',
      data: { unknownDocuments: ['preparationTicket'] },
    })
    await expect(printing).rejects.toMatchObject({ code: 'USB_PREPARATION_WRITE_PARTIAL' })
    await getPrinterStatusForDevice(device)
    expect(native.printJob).toHaveBeenCalledTimes(1)
    expect(isUsbPrinting()).toBe(false)
  })

  it('garde les sondes exclues jusqu’à la fin de toutes les impressions demandées', async () => {
    const first = deferred<never>()
    const second = deferred<never>()
    native.printJob.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = epsonUsbPrinter.printJob(1, [])
    const b = epsonUsbPrinter.printJob(1, [])
    first.reject(new Error('échec'))
    await expect(a).rejects.toThrow('échec')
    await expect(getPrinterStatusForDevice(device)).resolves.toBe('printing')
    second.reject(new Error('échec'))
    await expect(b).rejects.toThrow('échec')
    expect(isUsbPrinting()).toBe(false)
  })

  it('le retour au premier plan pendant une impression ne touche pas au statut USB', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const job = deferred<never>()
    native.printJob.mockReturnValueOnce(job.promise)
    const printing = epsonUsbPrinter.printJob(1, [])
    const { result } = renderHook(() => usePrinterStatus())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toBe('printing')
    for (const value of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    }
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(native.getStatus).not.toHaveBeenCalled()
    await act(async () => {
      job.reject(new Error('partiel'))
      await printing.catch(() => undefined)
    })
    expect(native.printJob).toHaveBeenCalledTimes(1)
    expect(result.current.status).not.toBe('ready')
  })
})
