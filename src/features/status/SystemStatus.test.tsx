import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemStatus } from './SystemStatus'
import type { PrinterStatus } from '../../types/system'

afterEach(cleanup)
describe('statut imprimante visible et accessible', () => {
  it.each<PrinterStatus>([
    'unknown',
    'unavailable',
    'permission-required',
    'ready',
    'printing',
    'disconnected',
    'paper-out',
    'cover-open',
    'status-unavailable',
    'error',
  ])('conserve l’accès à la configuration pour %s', (printer) => {
    const open = vi.fn()
    render(<SystemStatus printer={printer} onPrinterClick={open} />)
    const button = screen.getByRole('button', { name: /Configurer l’imprimante. Statut :/ })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-live', 'polite')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('distingue un défaut ancien d’une nouvelle observation', () => {
    render(<SystemStatus printer="paper-out" isStale onPrinterClick={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: /Plus de papier \(dernier contrôle ancien\)/ }),
    ).toBeInTheDocument()
  })
})
