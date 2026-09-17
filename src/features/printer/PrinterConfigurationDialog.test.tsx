import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { epsonUsbPrinter, type UsbPrinterDevice } from '../../native/epsonUsbPrinter'
import { getPreferredUsbPrinter } from '../../services/printerSelectionService'
import { printUsbTestTicket } from '../../services/printerTestService'
import { PrinterConfigurationDialog } from './PrinterConfigurationDialog'

vi.mock('../../native/epsonUsbPrinter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../native/epsonUsbPrinter')>()),
  epsonUsbPrinter: {
    isAndroidNative: vi.fn(() => true),
    getDevices: vi.fn(),
    getStatus: vi.fn(),
    requestPermission: vi.fn(),
  },
}))

vi.mock('../../services/printerTestService', () => ({
  printUsbTestTicket: vi.fn(),
}))

const printer: UsbPrinterDevice = {
  deviceId: 1,
  deviceName: 'printer-a',
  vendorId: 0x04b8,
  productId: 0x0202,
  manufacturerName: 'EPSON',
  productName: 'TM-T88V',
  serialNumber: 'A',
  epson: true,
  hasPermission: true,
  hasBulkOutEndpoint: true,
  hasBulkInEndpoint: true,
}

const readyStatus = {
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

function openDialog(onStatusChanged = vi.fn()) {
  render(
    <PrinterConfigurationDialog
      initialStatus="unknown"
      onClose={vi.fn()}
      onStatusChanged={onStatusChanged}
    />,
  )
}

describe('configuration de l’imprimante', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(epsonUsbPrinter.isAndroidNative).mockReturnValue(true)
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer] })
    vi.mocked(epsonUsbPrinter.getStatus).mockResolvedValue(readyStatus)
    vi.mocked(printUsbTestTicket).mockResolvedValue(84)
  })

  it('affiche l’absence d’imprimante sans crasher', async () => {
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [] })
    openDialog()

    expect(await screen.findByText('Imprimante non détectée')).toBeInTheDocument()
    expect(screen.getByText(/Aucune imprimante détectée/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connecter' })).toBeDisabled()
  })

  it('demande la permission puis annonce l’imprimante prête', async () => {
    const unauthorized = { ...printer, hasPermission: false, serialNumber: null }
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [unauthorized] })
    vi.mocked(epsonUsbPrinter.requestPermission).mockResolvedValue({
      granted: true,
      device: printer,
    })
    openDialog()

    expect(await screen.findByText('Connexion à autoriser')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connecter' }))

    expect(await screen.findByText('Imprimante connectée et prête.')).toBeInTheDocument()
    expect(epsonUsbPrinter.requestPermission).toHaveBeenCalledWith(printer.deviceId)
    expect(screen.getByRole('button', { name: 'Reconnecter' })).toBeEnabled()
  })

  it('explique un refus de permission et permet de réessayer', async () => {
    const unauthorized = { ...printer, hasPermission: false, serialNumber: null }
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [unauthorized] })
    vi.mocked(epsonUsbPrinter.requestPermission).mockResolvedValue({
      granted: false,
      device: unauthorized,
    })
    openDialog()

    await screen.findByText('Connexion à autoriser')
    fireEvent.click(screen.getByRole('button', { name: 'Connecter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion refusée')
    expect(screen.getByRole('button', { name: 'Connecter' })).toBeEnabled()
  })

  it('sélectionne et mémorise une autre imprimante parmi plusieurs', async () => {
    const second = {
      ...printer,
      deviceId: 2,
      deviceName: 'printer-b',
      productName: 'TM-T88V caisse 2',
      serialNumber: 'B',
    }
    vi.mocked(epsonUsbPrinter.getDevices).mockResolvedValue({ devices: [printer, second] })
    openDialog()

    const secondChoice = await screen.findByRole('button', { name: /TM-T88V caisse 2/ })
    fireEvent.click(secondChoice)

    await waitFor(() => expect(secondChoice).toHaveAttribute('aria-pressed', 'true'))
    expect(getPreferredUsbPrinter()?.serialNumber).toBe('B')
    expect(screen.getByText(/Imprimante sélectionnée :/)).toHaveTextContent('TM-T88V caisse 2')
    expect(screen.queryByText(/VID|PID|0x04B8/)).not.toBeInTheDocument()
  })

  it('reflète une déconnexion pendant la reconnexion', async () => {
    vi.mocked(epsonUsbPrinter.getStatus)
      .mockResolvedValueOnce(readyStatus)
      .mockRejectedValueOnce({ code: 'USB_DEVICE_NOT_FOUND' })
    openDialog()

    await screen.findByText('Imprimante connectée')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Imprimante non détectée')
    expect(screen.getAllByText('Imprimante non détectée')).toHaveLength(2)
  })

  it('confirme une impression de test réussie', async () => {
    openDialog()
    await screen.findByText('Imprimante connectée')

    fireEvent.click(screen.getByRole('button', { name: 'Tester l’impression' }))

    expect(await screen.findByText(/Ticket de test imprimé/)).toBeInTheDocument()
    expect(screen.queryByText(/octets/)).not.toBeInTheDocument()
    expect(printUsbTestTicket).toHaveBeenCalledWith(printer.deviceId)
  })

  it('présente simplement un échec d’écriture du ticket de test', async () => {
    vi.mocked(printUsbTestTicket).mockRejectedValue({ code: 'USB_PRINT_JOB_WRITE_FAILED' })
    openDialog()
    await screen.findByText('Imprimante connectée')

    fireEvent.click(screen.getByRole('button', { name: 'Tester l’impression' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('L’impression de test a échoué')
  })
})
