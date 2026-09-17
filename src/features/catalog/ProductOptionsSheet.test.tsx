import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Product } from '../../types/catalog'
import { ProductOptionsSheet } from './ProductOptionsSheet'

const product: Product = {
  id: 'generic-options-test',
  name: 'Produit configurable',
  categoryId: 'assiettes',
  active: true,
  displayOrder: 0,
  requiresPreparation: true,
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
  it('sélectionne tous les ingrédients par défaut et transmet ceux qui sont retirés', () => {
    const onConfirm = vi.fn()
    const ingredientsOnlyProduct: Product = {
      id: 'ingredients-only-test',
      name: 'Produit à composer',
      categoryId: 'assiettes',
      active: true,
      displayOrder: 0,
      requiresPreparation: true,
      availability: 'available',
      priceCents: 1200,
      vatRate: 10,
      ingredients: [
        { id: 'pain', name: 'Pain' },
        { id: 'cheddar', name: 'Cheddar' },
      ],
    }

    render(
      <ProductOptionsSheet
        product={ingredientsOnlyProduct}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByRole('checkbox', { name: 'Pain' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Cheddar' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheddar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Produit à composer' }))

    expect(onConfirm).toHaveBeenCalledWith({ variantId: undefined, optionIdsByGroup: {} }, [
      'cheddar',
    ])
  })

  it('annule au clic sur l’overlay sans annuler les interactions internes', () => {
    const onCancel = vi.fn()
    render(<ProductOptionsSheet product={product} onCancel={onCancel} onConfirm={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Grande/ }))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('dialog', { name: 'Produit configurable' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

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
