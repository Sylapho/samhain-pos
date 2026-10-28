import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePrinterStatus } from './usePrinterStatus'
import type { PrinterStatus } from '../../types/system'

function deferred() {
  let resolve!: (value: PrinterStatus) => void
  const promise = new Promise<PrinterStatus>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
}

describe('surveillance de l’imprimante', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('contrôle immédiatement, puis seulement après 60 secondes', async () => {
    const probe = vi.fn().mockResolvedValue('ready')
    const { result } = renderHook(() => usePrinterStatus(probe))
    expect(result.current.status).toBe('unknown')
    await flush()
    expect(result.current.status).toBe('ready')
    await act(() => vi.advanceTimersByTimeAsync(59_999))
    expect(probe).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('n’a ni sonde initiale ni timer quand la page est cachée', async () => {
    visibility('hidden')
    const probe = vi.fn().mockResolvedValue('ready')
    renderHook(() => usePrinterStatus(probe))
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(probe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    visibility('visible')
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('suspend explicitement le timer et vérifie au retour sans conserver une certitude ancienne', async () => {
    const next = deferred()
    const probe = vi.fn().mockResolvedValueOnce('ready').mockReturnValue(next.promise)
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    visibility('hidden')
    expect(vi.getTimerCount()).toBe(0)
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(probe).toHaveBeenCalledTimes(1)
    visibility('visible')
    await flush()
    expect(result.current.status).toBe('status-unavailable')
    expect(result.current.isStale).toBe(true)
    await act(async () => next.resolve('paper-out'))
    expect(result.current.status).toBe('paper-out')
    expect(result.current.isStale).toBe(false)
  })

  it('ignore le résultat commencé avant la mise en arrière-plan et recontrôle au retour', async () => {
    const old = deferred()
    const probe = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('disconnected')
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    visibility('hidden')
    visibility('visible')
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    await act(async () => old.resolve('ready'))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('disconnected')
  })

  it('regroupe les actualisations manuelles pendant une sonde et ignore sa réponse obsolète', async () => {
    const old = deferred()
    const next = deferred()
    const probe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    act(() => {
      result.current.refresh()
      result.current.refresh()
    })
    expect(probe).toHaveBeenCalledTimes(1)
    await act(async () => old.resolve('ready'))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('unknown')
    await act(async () => next.resolve('cover-open'))
    expect(result.current.status).toBe('cover-open')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('actualise manuellement sans recréer de timer supplémentaire', async () => {
    const probe = vi.fn().mockResolvedValueOnce('ready').mockResolvedValue('paper-out')
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    act(() => result.current.refresh())
    await flush()
    expect(result.current.status).toBe('paper-out')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('ne chevauche pas une sonde lente et expire l’ancien statut pendant son attente', async () => {
    const slow = deferred()
    const probe = vi.fn().mockResolvedValueOnce('ready').mockReturnValue(slow.promise)
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.status).toBe('status-unavailable')
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(probe).toHaveBeenCalledTimes(2)
    await act(async () => slow.resolve('ready'))
    expect(vi.getTimerCount()).toBe(1)
  })

  it('ne rajeunit pas une observation lorsque la sonde est ignorée pendant une impression', async () => {
    const probe = vi.fn().mockResolvedValueOnce('paper-out').mockResolvedValue('printing')
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.status).toBe('paper-out')
    expect(result.current.isStale).toBe(true)
  })

  it('survit aux erreurs temporaires et reprend les vérifications', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce('ready')
      .mockRejectedValueOnce(new Error('USB'))
      .mockResolvedValue('ready')
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.status).toBe('status-unavailable')
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.status).toBe('ready')
  })

  it('arrête le polling sur le web sans imprimante native', async () => {
    const probe = vi.fn().mockResolvedValue('unavailable')
    const { result } = renderHook(() => usePrinterStatus(probe))
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(probe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current.status).toBe('unavailable')
  })

  it('nettoie au démontage et n’applique aucune réponse tardive', async () => {
    const old = deferred()
    const probe = vi.fn().mockReturnValue(old.promise)
    const { result, unmount } = renderHook(() => usePrinterStatus(probe))
    await flush()
    unmount()
    visibility('visible')
    await act(async () => old.resolve('ready'))
    expect(result.current.status).toBe('unknown')
    expect(vi.getTimerCount()).toBe(0)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('ignore la réponse de l’ancienne sonde après changement de dépendance', async () => {
    const old = deferred()
    const first = vi.fn().mockReturnValue(old.promise)
    const second = vi.fn().mockResolvedValue('disconnected')
    const { result, rerender } = renderHook(({ probe }) => usePrinterStatus(probe), {
      initialProps: { probe: first },
    })
    await flush()
    rerender({ probe: second })
    await flush()
    await act(async () => old.resolve('ready'))
    expect(result.current.status).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('ne duplique ni sonde ni timer sous StrictMode et après remontage', async () => {
    const probe = vi.fn().mockResolvedValue('ready')
    const first = renderHook(() => usePrinterStatus(probe), { wrapper: StrictMode })
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    first.unmount()
    expect(vi.getTimerCount()).toBe(0)
    renderHook(() => usePrinterStatus(probe), { wrapper: StrictMode })
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })
})
