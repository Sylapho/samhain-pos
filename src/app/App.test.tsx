import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetMockOrderSequenceForTests } from '../services/orderService'
import { useCartStore } from '../store/cartStore'
import { App } from './App'

describe('caisse', () => {
  beforeEach(() => {
    useCartStore.getState().clearCart()
    resetMockOrderSequenceForTests()
  })

  it('désactive la validation et l’annulation lorsque la commande est vide', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annuler la commande' })).toBeDisabled()
  })

  it('ajoute un produit simple en un appui puis modifie sa quantité', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Burger spécial Samhain, 16,00/ }))
    const quantity = screen.getByLabelText('Quantité Burger spécial Samhain')
    expect(quantity).toBeInTheDocument()
    fireEvent.click(
      within(quantity).getByRole('button', { name: 'Augmenter Burger spécial Samhain' }),
    )
    expect(within(quantity).getByText('2')).toBeInTheDocument()
  })

  it('annule puis valide une personnalisation et la retrouve à la réouverture', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Burger spécial Samhain, 16,00/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    const cheddar = screen.getByRole('checkbox', { name: 'Cheddar' })
    expect(cheddar).toBeChecked()
    fireEvent.click(cheddar)
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.queryByText('Sans cheddar')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    expect(screen.getByRole('checkbox', { name: 'Cheddar' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheddar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(screen.getByText('Sans cheddar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Burger spécial Samhain' }))
    expect(screen.getByRole('checkbox', { name: 'Cheddar' })).not.toBeChecked()
  })

  it('applique la taille par défaut puis permet de la modifier depuis le panier', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Sans alcool/ }))
    fireEvent.click(screen.getByRole('button', { name: /Coca-Cola, à partir de 2,50/ }))
    expect(screen.getByRole('button', { name: /33 cl/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Coca-Cola' }))
    expect(screen.getByText('Taille : 33 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    fireEvent.click(screen.getByRole('button', { name: /50 cl/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.getByText('Taille : 33 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    expect(screen.getByRole('button', { name: /33 cl/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /50 cl/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(screen.getByText('Taille : 50 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    expect(screen.getByRole('button', { name: /50 cl/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('compose un menu enfant puis ouvre l’encaissement', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Menu enfant/ }))
    fireEvent.click(screen.getByRole('button', { name: /Nuggets/ }))
    fireEvent.click(screen.getByRole('button', { name: /Glace/ }))
    fireEvent.click(screen.getByRole('button', { name: /Jus de pomme/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Menu enfant' }))
    expect(screen.getByText('Dessert : Glace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Valider la commande' }))
    expect(screen.getByRole('dialog', { name: 'Encaissement' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Carte bancaire' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('checkbox', { name: /Imprimer le ticket client/ })).toBeChecked()
  })

  it('protège l’annulation de la commande par une confirmation', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la commande' }))
    expect(screen.getByRole('dialog', { name: 'Annuler cette commande ?' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Annuler la commande' })[1]!)
    expect(screen.getByText('Commande vide')).toBeInTheDocument()
  })
})
