import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { epsonUsbPrinter, type UsbPrinterDevice } from '../../native/epsonUsbPrinter'
import {
  getPrinterStatusForDevice,
  printerStatusFromError,
} from '../../services/printerStatusService'
import {
  getPreferredUsbPrinter,
  preferredPrinterLabel,
  savePreferredUsbPrinter,
  selectConfiguredUsbPrinter,
  type PreferredUsbPrinter,
} from '../../services/printerSelectionService'
import { printUsbTestTicket } from '../../services/printerTestService'
import type { PrinterStatus } from '../../types/system'
import { printerActionError, usbDeviceLabel } from './printerConfigurationUi'

type Message = { kind: 'info' | 'success' | 'error'; text: string }

const configurationStatusLabels: Record<PrinterStatus, string> = {
  unknown: 'Vérification de l’imprimante…',
  unavailable: 'Réglage disponible uniquement sur la tablette',
  'permission-required': 'Connexion à autoriser',
  ready: 'Imprimante connectée',
  printing: 'Impression de test en cours…',
  disconnected: 'Imprimante non détectée',
  'paper-out': 'Plus de papier',
  'cover-open': 'Capot ouvert',
  'status-unavailable': 'État de l’imprimante non vérifié',
  error: 'Imprimante à vérifier',
}

export function PrinterConfigurationDialog({
  initialStatus,
  onClose,
  onStatusChanged,
}: {
  initialStatus: PrinterStatus
  onClose: () => void
  onStatusChanged: () => void
}) {
  const [devices, setDevices] = useState<UsbPrinterDevice[]>([])
  const [preferred, setPreferred] = useState<PreferredUsbPrinter | null>(() =>
    getPreferredUsbPrinter(),
  )
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [status, setStatus] = useState<PrinterStatus>(initialStatus)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const androidNative = epsonUsbPrinter.isAndroidNative()

  const relevantDevices = useMemo(
    () => devices.filter((device) => device.epson || device.hasBulkOutEndpoint),
    [devices],
  )
  const selected = useMemo(
    () => devices.find((device) => device.deviceId === selectedId) ?? null,
    [devices, selectedId],
  )

  const refresh = useCallback(
    async (preserveMessage = false) => {
      if (!androidNative) {
        setDevices([])
        setStatus('unavailable')
        if (!preserveMessage) {
          setMessage({
            kind: 'info',
            text: 'L’imprimante peut être réglée depuis l’application installée sur la tablette.',
          })
        }
        return
      }

      setBusy(true)
      if (!preserveMessage) setMessage(null)
      try {
        const { devices: detected } = await epsonUsbPrinter.getDevices()
        const saved = getPreferredUsbPrinter()
        const next = selectConfiguredUsbPrinter(detected, saved)
        setDevices(detected)
        setPreferred(saved)
        setSelectedId(next?.deviceId ?? null)

        if (!next) {
          setStatus('disconnected')
          if (!preserveMessage) {
            setMessage({
              kind: 'error',
              text: saved
                ? 'L’imprimante sélectionnée est déconnectée. Rebranchez-la ou choisissez une autre imprimante.'
                : 'Aucune imprimante compatible détectée. Vérifiez le câble et l’alimentation.',
            })
          }
        } else {
          const nextStatus = await getPrinterStatusForDevice(next)
          setStatus(nextStatus)
          if (!preserveMessage && nextStatus === 'ready') {
            setMessage({ kind: 'success', text: 'L’imprimante est connectée et prête.' })
          }
        }
      } catch (error) {
        setStatus(printerStatusFromError(error))
        if (!preserveMessage) setMessage({ kind: 'error', text: printerActionError(error) })
      } finally {
        setBusy(false)
        onStatusChanged()
      }
    },
    [androidNative, onStatusChanged],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const choosePrinter = async (device: UsbPrinterDevice) => {
    if (!device.epson || !device.hasBulkOutEndpoint || busy) return
    setBusy(true)
    setSelectedId(device.deviceId)
    try {
      const saved = savePreferredUsbPrinter(device)
      setPreferred(saved)
      const nextStatus = await getPrinterStatusForDevice(device)
      setStatus(nextStatus)
      setMessage({
        kind: nextStatus === 'ready' ? 'success' : 'info',
        text:
          nextStatus === 'ready'
            ? 'Cette imprimante est sélectionnée et prête.'
            : nextStatus === 'permission-required'
              ? 'Imprimante sélectionnée. Appuyez sur Connecter pour autoriser la connexion.'
              : 'Imprimante sélectionnée. Utilisez Reconnecter pour vérifier son état.',
      })
    } catch (error) {
      setStatus(printerStatusFromError(error))
      setMessage({ kind: 'error', text: printerActionError(error) })
    } finally {
      setBusy(false)
      onStatusChanged()
    }
  }

  const connect = async () => {
    if (!selected || busy) return
    setBusy(true)
    setMessage({
      kind: 'info',
      text: selected.hasPermission
        ? 'Vérification de la connexion…'
        : 'Une demande d’autorisation va s’afficher…',
    })
    try {
      let connectedDevice = selected
      if (!selected.hasPermission) {
        const permission = await epsonUsbPrinter.requestPermission(selected.deviceId)
        if (!permission.granted) {
          setStatus('permission-required')
          setMessage({
            kind: 'error',
            text: 'Connexion refusée. Appuyez sur Connecter pour réessayer.',
          })
          return
        }
        connectedDevice = permission.device
        setDevices((current) =>
          current.map((device) =>
            device.deviceId === connectedDevice.deviceId ? connectedDevice : device,
          ),
        )
      }

      const saved = savePreferredUsbPrinter(connectedDevice)
      setPreferred(saved)
      const nextStatus = await getPrinterStatusForDevice(connectedDevice)
      setStatus(nextStatus)
      setMessage({
        kind: nextStatus === 'ready' ? 'success' : 'error',
        text:
          nextStatus === 'ready'
            ? 'Imprimante connectée et prête.'
            : configurationStatusLabels[nextStatus],
      })
    } catch (error) {
      setStatus(printerStatusFromError(error))
      setMessage({ kind: 'error', text: printerActionError(error) })
    } finally {
      setBusy(false)
      onStatusChanged()
    }
  }

  const printTest = async () => {
    if (!selected || busy) return
    setBusy(true)
    setStatus('printing')
    setMessage({ kind: 'info', text: 'Impression du ticket de test…' })
    try {
      await printUsbTestTicket(selected.deviceId)
      setStatus('ready')
      setMessage({
        kind: 'success',
        text: 'Ticket de test imprimé.',
      })
    } catch (error) {
      setStatus(printerStatusFromError(error))
      setMessage({ kind: 'error', text: printerActionError(error, true) })
    } finally {
      setBusy(false)
      onStatusChanged()
    }
  }

  const selectedLabel = selected
    ? usbDeviceLabel(selected)
    : preferred
      ? preferredPrinterLabel(preferred)
      : 'Aucune imprimante sélectionnée'

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-[#f2eee5] text-stone-950"
      role="dialog"
      aria-modal="true"
      aria-labelledby="printer-configuration-title"
    >
      <header className="sticky top-0 z-10 flex min-h-16 items-center gap-4 border-b border-stone-700 bg-[#18231e] px-4 py-2 text-white sm:px-6">
        <Button
          variant="headerSecondary"
          className="min-h-11 px-4 py-2"
          onClick={onClose}
        >
          Retour
        </Button>
        <h1 id="printer-configuration-title" className="text-xl font-black">
          Imprimante
        </h1>
      </header>

      <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
        <section className="border-b border-stone-300 pb-5" aria-label="État de l’imprimante">
          <p className="text-sm font-bold text-stone-600">État actuel</p>
          <p className="mt-1 text-2xl font-black" aria-live="polite">
            {configurationStatusLabels[status]}
          </p>
          <p className="mt-3 font-bold">
            Imprimante sélectionnée : <span className="font-black">{selectedLabel}</span>
            {!selected && preferred ? ' (déconnectée)' : ''}
          </p>
          <p className="mt-1 text-sm font-bold text-stone-600">
            Connexion : {selected?.hasPermission ? 'autorisée' : 'à autoriser'}
          </p>
        </section>

        <section className="py-5" aria-labelledby="detected-printers-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="detected-printers-title" className="text-lg font-black">
              Imprimantes détectées
            </h2>
            <Button disabled={busy} onClick={() => void refresh()}>
              Actualiser
            </Button>
          </div>

          {relevantDevices.length ? (
            <div className="mt-3 grid gap-3">
              {relevantDevices.map((device) => {
                const compatible = device.epson && device.hasBulkOutEndpoint
                const active = device.deviceId === selectedId
                return (
                  <button
                    type="button"
                    key={`${device.deviceName}-${device.deviceId}`}
                    className={`min-h-20 rounded-[10px] border p-4 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${
                      active
                        ? 'border-[#1f6a4b] bg-emerald-50'
                        : 'border-stone-300 bg-white active:bg-stone-100'
                    } disabled:text-stone-500`}
                    aria-pressed={active}
                    disabled={!compatible || busy}
                    onClick={() => void choosePrinter(device)}
                  >
                    <span className="block text-lg font-black">{usbDeviceLabel(device)}</span>
                    <span className="mt-1 block text-sm font-bold text-stone-600">
                      {compatible ? 'Compatible avec la caisse' : 'Imprimante non compatible'} ·
                      Connexion {device.hasPermission ? 'autorisée' : 'à autoriser'}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="mt-3 border border-amber-300 bg-amber-50 p-4 font-bold text-amber-950">
              Aucune imprimante détectée. Vérifiez le câble et l’alimentation, puis appuyez sur
              Actualiser.
            </p>
          )}
        </section>

        {message ? (
          <p
            className={`border p-4 font-bold ${
              message.kind === 'error'
                ? 'border-rose-300 bg-rose-50 text-rose-950'
                : message.kind === 'success'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                  : 'border-sky-300 bg-sky-50 text-sky-950'
            }`}
            role={message.kind === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button
            variant="primary"
            className="min-h-14 text-lg"
            disabled={!selected || busy}
            onClick={() => void connect()}
          >
            {selected?.hasPermission ? 'Reconnecter' : 'Connecter'}
          </Button>
          <Button
            className="min-h-14 text-lg"
            disabled={!selected?.hasPermission || !selected.hasBulkOutEndpoint || busy}
            onClick={() => void printTest()}
          >
            Tester l’impression
          </Button>
        </div>
      </main>
    </div>
  )
}
