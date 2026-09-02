import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Product } from '../../types/catalog'
import { ProductOptionsSheet } from './ProductOptionsSheet'

const product: Product = {
  id: 'generic-options-test',
  name: 'Produit configurable',
  categoryId: 'assiettes',
  availability: 'available',
  priceCents: 1000,
  vatRate: 10,
  optionGroups: [
    {
      id: 'taille',
      name: 'Taille',
      type: 'single',
      required: true,
      options: [
        { id: 'petite', name: 'Petite' },
        { id: 'grande', name: 'Grande' },
      ],
    },
    {
      id: 'extras',
      name: 'Suppléments',
      type: 'multiple',
      required: false,
      options: [
        { id: 'bacon', name: 'Bacon' },
        { id: 'oignons', name: 'Oignons' },
      ],
    },
  ],
}

describe('fiche d’options générique', () => {
  it('bloque un groupe obligatoire et transmet plusieurs choix après validation', () => {
    const onConfirm = vi.fn()
    render(<ProductOptionsSheet product={product} onCancel={vi.fn()} onConfirm={onConfirm} />)

    expect(screen.getByRole('button', { name: 'Choix requis' })).toBeDisabled()
    expect(screen.getByText('Choisissez une option.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Grande/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bacon/ }))
    fireEvent.click(screen.getByRole('button', { name: /Oignons/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Produit configurable' }))

    expect(onConfirm).toHaveBeenCalledWith(
      {
        variantId: undefined,
        optionIdsByGroup: { taille: ['grande'], extras: ['bacon', 'oignons'] },
      },
      [],
    )
  })
})
