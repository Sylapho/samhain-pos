import { useEffect, useState } from 'react'
import { getPrinterStatus } from '../../services/printerStatusService'
import type { PrinterStatus } from '../../types/system'

const PRINTER_CHECK_INTERVAL_MS = 3_000

export type PrinterStatusProbe = () => Promise<PrinterStatus>

export function usePrinterStatus(probe: PrinterStatusProbe = getPrinterStatus): PrinterStatus {
  const [status, setStatus] = useState<PrinterStatus>('unknown')

  useEffect(() => {
    let active = true
    let checking = false

    const check = async () => {
      if (checking) return
      checking = true
      try {
        const nextStatus = await probe()
        if (active) setStatus(nextStatus)
      } catch {
        if (active) setStatus('error')
      } finally {
        checking = false
      }
    }

    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }

    void check()
    const interval = window.setInterval(() => void check(), PRINTER_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', checkWhenVisible)

    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', checkWhenVisible)
    }
  }, [probe])

  return status
}
