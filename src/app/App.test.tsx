import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCartStore } from '../store/cartStore'
import { App } from './App'

describe('caisse', () => {
  beforeEach(() => useCartStore.getState().clearCart())
  it('désactive Encaisser lorsque le panier est vide', () => { render(<App />); expect(screen.getByRole('button', { name: 'Encaisser' })).toBeDisabled() })
  it('ajoute un produit par appui', () => { render(<App />); fireEvent.click(screen.getByRole('button', { name: /Burger Samhain \+ frites/ })); expect(screen.getByLabelText('Quantité Burger Samhain + frites')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Encaisser' })).toBeEnabled() })
  it('désactive un produit épuisé', () => { render(<App />); expect(screen.getByRole('button', { name: /Merguez x2 \+ frites.*épuisé/ })).toBeDisabled() })
})
