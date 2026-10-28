import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ProductStatisticsSelector } from './ProductStatisticsSelector'

const products = Array.from({ length: 80 }, (_, index) => ({
  id: `product-${index}`,
  name: `Produit ${index}`,
}))

function Selector({ initial = new Set<string>() }) {
  const [selection, setSelection] = useState(initial)
  return (
    <ProductStatisticsSelector
      products={products}
      selection={selection}
      onToggle={(id) =>
        setSelection((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      onSelectAll={() => setSelection(new Set(products.map(({ id }) => id)))}
      onClear={() => setSelection(new Set())}
    />
  )
}

describe('sélecteur des statistiques', () => {
  it('reste compact, recherche parmi de nombreux produits et conserve les choix après fermeture', () => {
    render(<Selector />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Produits sélectionnés (0)' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(80)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Produit 79' } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Produit 79' }))
    fireEvent.click(screen.getByRole('button', { name: 'Terminer' }))
    const trigger = screen.getByRole('button', { name: 'Produits sélectionnés (1)' })
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    expect(screen.getByRole('checkbox', { name: 'Produit 79' })).toBeChecked()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'introuvable' } })
    expect(screen.getByText('Aucun produit trouvé.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tout sélectionner' }))
    expect(screen.getByRole('button', { name: 'Produits sélectionnés (80)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tout désélectionner' }))
    expect(screen.getByRole('button', { name: 'Produits sélectionnés (0)' })).toBeInTheDocument()
  })

  it('se ferme par appui extérieur ou Échap sans perdre les produits sélectionnés', () => {
    render(<Selector initial={new Set(['product-0', 'product-1'])} />)
    const trigger = screen.getByRole('button', { name: 'Produits sélectionnés (2)' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('checkbox', { name: 'Produit 0' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.getByRole('checkbox', { name: 'Produit 1' })).toBeChecked()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('borne le portail au viewport visible et réagit au clavier et au redimensionnement', () => {
    const visualViewport = new EventTarget()
    Object.assign(visualViewport, { width: 800, height: 320, offsetLeft: 0, offsetTop: 100 })
    vi.stubGlobal('visualViewport', visualViewport)
    try {
      render(<Selector />)
      fireEvent.click(screen.getByRole('button', { name: 'Produits sélectionnés (0)' }))
      const panel = screen.getByRole('dialog')
      expect(panel.parentElement).toBe(document.body)
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(112)
      expect(
        Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.maxHeight),
      ).toBeLessThanOrEqual(408)
      Object.assign(visualViewport, { width: 360, height: 200 })
      act(() => {
        visualViewport.dispatchEvent(new Event('resize'))
      })
      expect(Number.parseFloat(panel.style.width)).toBe(336)
      expect(
        Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.maxHeight),
      ).toBeLessThanOrEqual(288)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
