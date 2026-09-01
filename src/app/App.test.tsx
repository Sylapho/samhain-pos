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

  it('compose un menu enfant puis ouvre l’encaissement', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Menu enfant/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Steak haché + frites' }))
    fireEvent.click(screen.getByRole('button', { name: 'Glace vanille — 1 boule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Jus de fruit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Menu enfant' }))
    expect(screen.getByText('Glace vanille — 1 boule')).toBeInTheDocument()
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
