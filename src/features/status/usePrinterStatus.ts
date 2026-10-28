import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isUsbPrinting, subscribeUsbPrinting } from '../../native/epsonUsbPrinter'
import { getPrinterStatus } from '../../services/printerStatusService'
import type { PrinterStatus } from '../../types/system'

export const PRINTER_CHECK_INTERVAL_MS = 60_000
export type PrinterStatusProbe = () => Promise<PrinterStatus>

// Shared across mounts (including StrictMode) so an unfinished check is never duplicated.
const checks = new WeakMap<PrinterStatusProbe, Promise<PrinterStatus>>()
function probeOnce(probe: PrinterStatusProbe) {
  const existing = checks.get(probe)
  if (existing) return existing
  const result = new Promise<PrinterStatus>((resolve) => resolve(probe())).finally(() =>
    checks.delete(probe),
  )
  checks.set(probe, result)
  return result
}

export function usePrinterStatus(probe: PrinterStatusProbe = getPrinterStatus): {
  status: PrinterStatus
  isStale: boolean
  refresh: () => void
} {
  const [observation, setObservation] = useState<{ status: PrinterStatus; stale: boolean }>({
    status: 'unknown',
    stale: false,
  })
  const printing = useSyncExternalStore(subscribeUsbPrinting, isUsbPrinting, () => false)
  const requestCheck = useRef<() => void>(() => undefined)
  const refresh = useCallback(() => requestCheck.current(), [])

  useEffect(() => {
    let active = true
    let checking = false
    let pending = false
    let generation = 0
    let timer: number | undefined
    let supported = true
    const visible = () => document.visibilityState === 'visible'
    const stop = () => {
      window.clearTimeout(timer)
      timer = undefined
    }
    const markStale = () => setObservation((current) => ({ ...current, stale: true }))
    const schedule = () => {
      stop()
      if (active && visible() && supported) {
        timer = window.setTimeout(() => {
          markStale()
          void check()
        }, PRINTER_CHECK_INTERVAL_MS)
      }
    }
    const check = async () => {
      if (!active || !visible()) return
      if (checking) {
        pending = true
        return
      }
      stop()
      checking = true
      pending = false
      const version = generation
      try {
        const status = await probeOnce(probe)
        if (active && visible() && version === generation) {
          supported = status !== 'unavailable'
          // A skipped probe is not a hardware observation and must not renew its age.
          if (status !== 'printing') setObservation({ status, stale: false })
        }
      } catch {
        if (active && visible() && version === generation) {
          setObservation({ status: 'status-unavailable', stale: false })
        }
      } finally {
        checking = false
        if (active) {
          if (pending && visible()) void check()
          else schedule()
        }
      }
    }
    const request = () => {
      generation += 1
      markStale()
      void check()
    }
    const visibilityChanged = () => {
      generation += 1
      stop()
      markStale()
      if (visible()) void check()
    }
    requestCheck.current = request
    const unsubscribePrinting = subscribeUsbPrinting(() => {
      if (isUsbPrinting()) {
        generation += 1
        markStale()
      }
    })
    document.addEventListener('visibilitychange', visibilityChanged)
    void check()
    return () => {
      active = false
      stop()
      requestCheck.current = () => undefined
      unsubscribePrinting()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [probe])

  return {
    status: printing
      ? 'printing'
      : observation.stale && observation.status === 'ready'
        ? 'status-unavailable'
        : observation.status,
    isStale:
      !printing &&
      observation.stale &&
      observation.status !== 'unknown' &&
      observation.status !== 'unavailable',
    refresh,
  }
}
