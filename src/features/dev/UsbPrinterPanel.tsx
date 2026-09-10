import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { printPreviewOrder } from '../../mocks/printOrder'
import {
  epsonUsbPrinter,
  type EpsonPrinterHardwareStatus,
  type UsbPrinterDevice,
} from '../../native/epsonUsbPrinter'
import { buildOrderPrintJob, printOrderTickets } from '../../printing/orderPrintService'

type Message = { kind: 'info' | 'success' | 'error'; text: string }

function deviceLabel(device: UsbPrinterDevice) {
  const name = device.productName || device.manufacturerName
  if (name) return name
  if (device.epson)
    return `Epson USB (${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')})`
  return `USB ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`
}

function hexByte(value: number) {
  return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`
}

export function UsbPrinterPanel() {
  const [devices, setDevices] = useState<UsbPrinterDevice[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [hardwareStatus, setHardwareStatus] = useState<EpsonPrinterHardwareStatus | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const androidNative = epsonUsbPrinter.isAndroidNative()

  const selected = useMemo(
    () => devices.find((device) => device.deviceId === selectedId) ?? null,
    [devices, selectedId],
  )

  const refresh = async (keepMessage = false) => {
    if (!androidNative) {
      setMessage({
        kind: 'info',
        text: 'Le test USB est disponible uniquement dans l’application Android Capacitor.',
      })
      return
    }

    setBusy(true)
    setHardwareStatus(null)
    if (!keepMessage) setMessage(null)
    try {
      const result = await epsonUsbPrinter.getDevices()
      setDevices(result.devices)
      const preferred =
        result.devices.find((device) => device.epson && device.hasBulkOutEndpoint) ??
        result.devices.find((device) => device.hasBulkOutEndpoint) ??
        result.devices[0]
      setSelectedId((current) =>
        result.devices.some((device) => device.deviceId === current)
          ? current
          : (preferred?.deviceId ?? null),
      )
      if (!result.devices.length) {
        setMessage({
          kind: 'error',
          text: 'Aucun périphérique USB détecté. Vérifiez le câble USB-C ↔ USB-B et que l’imprimante est allumée.',
        })
      } else if (!keepMessage) {
        setMessage({
          kind: 'success',
          text: `${result.devices.length} périphérique(s) USB détecté(s).`,
        })
      }
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Impossible de lire les périphériques USB.',
      })
    } finally {
      setBusy(false)
    }
  }

  const readStatus = async () => {
    if (!selected) return
    setBusy(true)
    setHardwareStatus(null)
    setMessage({ kind: 'info', text: 'Lecture DLE EOT 2, 3 et 4 en cours…' })
    try {
      const status = await epsonUsbPrinter.getStatus(selected.deviceId)
      setHardwareStatus(status)
      setMessage({
        kind: status.online ? 'success' : 'error',
        text: status.online
          ? 'La TM-T88V a répondu et ne signale aucune anomalie bloquante.'
          : 'La TM-T88V a répondu avec un état bloquant.',
      })
    } catch (error) {
      setMessage({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Impossible de lire le statut matériel de l’imprimante.',
      })
    } finally {
      setBusy(false)
    }
  }

  const authorize = async () => {
    if (!selected) return
    setBusy(true)
    setMessage({ kind: 'info', text: 'Demande d’autorisation USB à Android…' })
    try {
      const result = await epsonUsbPrinter.requestPermission(selected.deviceId)
      setMessage(
        result.granted
          ? { kind: 'success', text: 'Accès USB autorisé. Vous pouvez lancer le ticket test.' }
          : { kind: 'error', text: 'Autorisation USB refusée.' },
      )
      await refresh(true)
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'La demande d’autorisation USB a échoué.',
      })
    } finally {
      setBusy(false)
    }
  }

  const printTest = async () => {
    if (!selected) return
    setBusy(true)
    setMessage({ kind: 'info', text: 'Envoi du ticket ESC/POS à l’imprimante…' })
    try {
      const result = await epsonUsbPrinter.printTest(selected.deviceId)
      setMessage({
        kind: 'success',
        text: `Ticket envoyé (${result.bytesWritten} octets). La coupe papier est incluse.`,
      })
      await refresh(true)
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Échec de l’impression USB.',
      })
    } finally {
      setBusy(false)
    }
  }

  const printFullOrder = async () => {
    if (!selected) return
    setBusy(true)
    setMessage({
      kind: 'info',
      text: 'Envoi du ticket client, coupe, préparation et seconde coupe…',
    })
    try {
      const result = await printOrderTickets(printPreviewOrder, { deviceId: selected.deviceId })
      setMessage({
        kind: result.warnings.length ? 'info' : 'success',
        text: result.warnings.length
          ? `Deux tickets envoyés. ${result.warnings.join(' ')}`
          : `Deux tickets envoyés en une séquence (${result.bytesWritten} octets).`,
      })
      await refresh(true)
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Échec de la séquence d’impression.',
      })
    } finally {
      setBusy(false)
    }
  }

  const previewDocuments = buildOrderPrintJob(printPreviewOrder).documents

  return (
    <section
      className="mt-4 rounded-2xl border border-slate-300 bg-white p-4"
      aria-labelledby="usb-printer-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="usb-printer-title" className="text-base font-black">
            Imprimante USB — test réel
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Diagnostic direct via Android USB Host et statut temps réel ESC/POS de la TM-T88V.
          </p>
        </div>
        <Button className="min-h-10 py-2" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Patientez…' : 'Détecter USB'}
        </Button>
      </div>

      {!androidNative ? (
        <div className="mt-3 rounded-xl bg-sky-50 p-3 font-bold text-sky-950">
          Ouvrez cette version dans l’application Android installée sur la tablette pour tester
          l’USB.
        </div>
      ) : null}

      {devices.length ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] lg:items-end">
          <label className="font-bold">
            Périphérique
            <select
              className="mt-1 block min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3"
              value={selectedId ?? ''}
              onChange={(event) => {
                setSelectedId(Number(event.target.value))
                setHardwareStatus(null)
              }}
            >
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {deviceLabel(device)}
                  {device.epson ? ' · Epson' : ''}
                  {device.hasPermission ? ' · autorisé' : ''}
                </option>
              ))}
            </select>
          </label>
          <Button
            className="min-h-12"
            disabled={!selected || busy || selected.hasPermission}
            onClick={() => void authorize()}
          >
            {selected?.hasPermission ? 'USB autorisé' : 'Autoriser USB'}
          </Button>
          <Button
            className="min-h-12"
            disabled={
              !selected?.hasPermission ||
              !selected.hasBulkOutEndpoint ||
              !selected.hasBulkInEndpoint ||
              busy
            }
            onClick={() => void readStatus()}
          >
            Lire le statut
          </Button>
          <Button
            variant="primary"
            className="min-h-12"
            disabled={!selected?.hasPermission || !selected.hasBulkOutEndpoint || busy}
            onClick={() => void printTest()}
          >
            Imprimer ticket test
          </Button>
          <Button
            variant="primary"
            className="min-h-12"
            disabled={!selected?.hasPermission || !selected.hasBulkOutEndpoint || busy}
            onClick={() => void printFullOrder()}
          >
            Imprimer les 2 tickets
          </Button>
        </div>
      ) : null}

      {selected ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-slate-600">
          <span>USB : connecté</span>
          <span>Permission : {selected.hasPermission ? 'oui' : 'non'}</span>
          <span>Vendor 0x{selected.vendorId.toString(16).padStart(4, '0').toUpperCase()}</span>
          <span>Product 0x{selected.productId.toString(16).padStart(4, '0').toUpperCase()}</span>
          <span>
            {selected.hasBulkOutEndpoint
              ? 'Sortie USB compatible détectée'
              : 'Aucune sortie BULK détectée'}
          </span>
          <span>
            {selected.hasBulkInEndpoint
              ? 'Entrée USB BULK détectée sur la même interface'
              : 'Aucune entrée BULK sur cette interface'}
          </span>
        </div>
      ) : null}

      {hardwareStatus ? (
        <div className="mt-3 border-y border-slate-200 py-3 text-sm" aria-label="Statut matériel">
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
            <span>Online : {hardwareStatus.online ? 'oui' : 'non'}</span>
            <span>Capot : {hardwareStatus.coverOpen ? 'ouvert' : 'fermé'}</span>
            <span>Papier : {hardwareStatus.paperOut ? 'absent' : 'présent'}</span>
            <span>Fin proche : {hardwareStatus.paperNearEnd ? 'oui' : 'non'}</span>
            <span>Erreur : {hardwareStatus.error ? 'oui' : 'non'}</span>
            <span>Cutter : {hardwareStatus.cutterError ? 'erreur' : 'normal'}</span>
            <span>Récupérable : {hardwareStatus.recoverableError ? 'oui' : 'non'}</span>
            <span>Irrécupérable : {hardwareStatus.unrecoverableError ? 'oui' : 'non'}</span>
            <span>Auto-récupérable : {hardwareStatus.autoRecoverableError ? 'oui' : 'non'}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 font-mono text-xs text-slate-600">
            <span>DLE EOT 2 : {hexByte(hardwareStatus.raw.offline)}</span>
            <span>DLE EOT 3 : {hexByte(hardwareStatus.raw.error)}</span>
            <span>DLE EOT 4 : {hexByte(hardwareStatus.raw.paper)}</span>
          </div>
        </div>
      ) : null}

      {message ? (
        <div
          className={`mt-3 rounded-xl p-3 font-bold ${message.kind === 'error' ? 'bg-rose-50 text-rose-900' : message.kind === 'success' ? 'bg-emerald-50 text-emerald-900' : 'bg-sky-50 text-sky-950'}`}
          role="status"
        >
          {message.text}
        </div>
      ) : null}

      <div className="mt-3">
        <Button
          className="min-h-10 py-2"
          disabled={busy}
          onClick={() => setShowPreview((visible) => !visible)}
        >
          {showPreview ? 'Masquer les aperçus' : 'Prévisualiser sans imprimante'}
        </Button>
        {showPreview ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {previewDocuments.map((document) => (
              <pre
                key={document.type}
                className="max-h-96 overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-5 text-stone-100"
              >
                {document.preview}
              </pre>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
