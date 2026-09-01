import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { epsonUsbPrinter, type UsbPrinterDevice } from '../../native/epsonUsbPrinter'

type Message = { kind: 'info' | 'success' | 'error'; text: string }

function deviceLabel(device: UsbPrinterDevice) {
  const name = device.productName || device.manufacturerName
  if (name) return name
  if (device.epson) return `Epson USB (${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')})`
  return `USB ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`
}

export function UsbPrinterPanel() {
  const [devices, setDevices] = useState<UsbPrinterDevice[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const androidNative = epsonUsbPrinter.isAndroidNative()

  const selected = useMemo(
    () => devices.find((device) => device.deviceId === selectedId) ?? null,
    [devices, selectedId],
  )

  const refresh = async (keepMessage = false) => {
    if (!androidNative) {
      setMessage({ kind: 'info', text: 'Le test USB est disponible uniquement dans l’application Android Capacitor.' })
      return
    }

    setBusy(true)
    if (!keepMessage) setMessage(null)
    try {
      const result = await epsonUsbPrinter.getDevices()
      setDevices(result.devices)
      const preferred = result.devices.find((device) => device.epson && device.hasBulkOutEndpoint)
        ?? result.devices.find((device) => device.hasBulkOutEndpoint)
        ?? result.devices[0]
      setSelectedId((current) => result.devices.some((device) => device.deviceId === current) ? current : preferred?.deviceId ?? null)
      if (!result.devices.length) {
        setMessage({ kind: 'error', text: 'Aucun périphérique USB détecté. Vérifiez le câble USB-C ↔ USB-B et que l’imprimante est allumée.' })
      } else if (!keepMessage) {
        setMessage({ kind: 'success', text: `${result.devices.length} périphérique(s) USB détecté(s).` })
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Impossible de lire les périphériques USB.' })
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
      setMessage(result.granted
        ? { kind: 'success', text: 'Accès USB autorisé. Vous pouvez lancer le ticket test.' }
        : { kind: 'error', text: 'Autorisation USB refusée.' })
      await refresh(true)
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'La demande d’autorisation USB a échoué.' })
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
      setMessage({ kind: 'success', text: `Ticket envoyé (${result.bytesWritten} octets). La coupe papier est incluse.` })
      await refresh(true)
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Échec de l’impression USB.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-slate-300 bg-white p-4" aria-labelledby="usb-printer-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="usb-printer-title" className="text-base font-black">Imprimante USB — test réel</h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Test matériel temporaire via Android USB Host + ESC/POS. Il ne remplace pas encore l’intégration ePOS SDK prévue pour la version finale.
          </p>
        </div>
        <Button className="min-h-10 py-2" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Patientez…' : 'Détecter USB'}
        </Button>
      </div>

      {!androidNative ? (
        <div className="mt-3 rounded-xl bg-sky-50 p-3 font-bold text-sky-950">
          Ouvrez cette version dans l’application Android installée sur la tablette pour tester l’USB.
        </div>
      ) : null}

      {devices.length ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
          <label className="font-bold">
            Périphérique
            <select
              className="mt-1 block min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3"
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(Number(event.target.value))}
            >
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {deviceLabel(device)}{device.epson ? ' · Epson' : ''}{device.hasPermission ? ' · autorisé' : ''}
                </option>
              ))}
            </select>
          </label>
          <Button className="min-h-12" disabled={!selected || busy || selected.hasPermission} onClick={() => void authorize()}>
            {selected?.hasPermission ? 'USB autorisé' : 'Autoriser USB'}
          </Button>
          <Button variant="primary" className="min-h-12" disabled={!selected?.hasPermission || !selected.hasBulkOutEndpoint || busy} onClick={() => void printTest()}>
            Imprimer ticket test
          </Button>
        </div>
      ) : null}

      {selected ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-slate-600">
          <span>Vendor 0x{selected.vendorId.toString(16).padStart(4, '0').toUpperCase()}</span>
          <span>Product 0x{selected.productId.toString(16).padStart(4, '0').toUpperCase()}</span>
          <span>{selected.hasBulkOutEndpoint ? 'Sortie USB compatible détectée' : 'Aucune sortie BULK détectée'}</span>
        </div>
      ) : null}

      {message ? (
        <div className={`mt-3 rounded-xl p-3 font-bold ${message.kind === 'error' ? 'bg-rose-50 text-rose-900' : message.kind === 'success' ? 'bg-emerald-50 text-emerald-900' : 'bg-sky-50 text-sky-950'}`} role="status">
          {message.text}
        </div>
      ) : null}
    </section>
  )
}
