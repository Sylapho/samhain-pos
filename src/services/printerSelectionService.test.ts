import { beforeEach, describe, expect, it } from 'vitest'
import type { UsbPrinterDevice } from '../native/epsonUsbPrinter'
import {
  getPreferredUsbPrinter,
  savePreferredUsbPrinter,
  selectConfiguredUsbPrinter,
} from './printerSelectionService'

const printer: UsbPrinterDevice = {
  deviceId: 1,
  deviceName: '/dev/bus/usb/001/002',
  vendorId: 0x04b8,
  productId: 0x0202,
  manufacturerName: 'EPSON',
  productName: 'TM-T88V',
  serialNumber: 'ABC123',
  epson: true,
  hasPermission: true,
  hasBulkOutEndpoint: true,
  hasBulkInEndpoint: true,
}

describe('sélection persistée de l’imprimante USB', () => {
  beforeEach(() => localStorage.clear())

  it('restaure l’imprimante par son numéro de série même si son deviceId change', () => {
    savePreferredUsbPrinter(printer)
    const reconnected = { ...printer, deviceId: 8, deviceName: '/dev/bus/usb/002/004' }

    expect(selectConfiguredUsbPrinter([reconnected])).toEqual(reconnected)
  })

  it('restaure un modèle unique lorsque le numéro de série est masqué sans permission', () => {
    savePreferredUsbPrinter(printer)
    const reconnected = {
      ...printer,
      deviceId: 8,
      deviceName: '/dev/bus/usb/002/004',
      serialNumber: null,
      hasPermission: false,
    }

    expect(selectConfiguredUsbPrinter([reconnected])).toEqual(reconnected)
  })

  it('ne choisit pas arbitrairement entre plusieurs imprimantes identiques', () => {
    savePreferredUsbPrinter(printer)
    const first = { ...printer, deviceId: 8, deviceName: 'other-a', serialNumber: null }
    const second = { ...printer, deviceId: 9, deviceName: 'other-b', serialNumber: null }

    expect(selectConfiguredUsbPrinter([first, second])).toBeUndefined()
  })

  it('ignore une préférence locale invalide', () => {
    localStorage.setItem('samhain-pos.preferred-usb-printer.v1', '{"vendorId":"epson"}')

    expect(getPreferredUsbPrinter()).toBeNull()
    expect(selectConfiguredUsbPrinter([printer])).toEqual(printer)
  })

  it('conserve la sélection pour la session si la persistance locale échoue', () => {
    const preferred = savePreferredUsbPrinter(printer, {
      setItem: () => {
        throw new Error('Stockage indisponible')
      },
    })

    expect(preferred.serialNumber).toBe('ABC123')
  })
})
