import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createValidCartItem } from '../../test/orderFixtures'
import type { Product } from '../../types/catalog'
import type { Order } from '../../types/order'
import { ProductSalesStatistics } from './ProductSalesStatistics'

const products: Product[] = [
  {
    id: 'burger',
    name: 'Burger',
    categoryId: 'assiettes',
    active: true,
    displayOrder: 0,
    requiresPreparation: true,
    availability: 'available',
    priceCents: 1_500,
    vatRate: 10,
  },
  {
    id: 'fries',
    name: 'Frites',
    categoryId: 'assiettes',
    active: true,
    displayOrder: 1,
    requiresPreparation: true,
    availability: 'available',
    priceCents: 300,
    vatRate: 10,
  },
]

const order: Order = {
  id: 'order-1',
  orderNumber: 'A-0001',
  receiptNumber: 'R-0001',
  paymentMethod: 'card',
  paymentStatus: 'paid',
  paidAt: '2026-09-01T12:00:00.000Z',
  items: [
    createValidCartItem({
      lineId: 'burger-line',
      productId: 'burger',
      name: 'Burger',
      quantity: 2,
      unitPriceCents: 1_000,
    }),
    createValidCartItem({
      lineId: 'fries-line',
      productId: 'fries',
      name: 'Frites',
      quantity: 1,
      unitPriceCents: 300,
    }),
  ],
  itemCount: 3,
  totalCents: 2_300,
  createdAt: '2026-09-01T12:00:00.000Z',
  status: 'confirmed',
  printing: {
    status: 'printed',
    pickupTicket: 'not_requested',
    customerReceipt: 'printed',
    preparationTicket: 'printed',
    attempts: 1,
    updatedAt: '2026-09-01T12:00:00.000Z',
  },
}

describe('vue des statistiques produits', () => {
  it('met immédiatement à jour la période et conserve les produits sans vente à zéro', () => {
    render(
      <ProductSalesStatistics
        orders={[order]}
        corrections={[]}
        products={products}
        now={new Date(2026, 8, 1, 12)}
      />,
    )

    const burgerRow = screen.getByRole('row', { name: /Burger/ })
    expect(within(burgerRow).getByText('2')).toBeInTheDocument()
    expect(within(burgerRow).getByText(/20,00/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Une date' }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-02' } })

    expect(screen.getByText('Aucune vente sur cette période.')).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /Burger/ })).getByText('0')).toBeInTheDocument()
  })

  it('permet de tout désélectionner puis de choisir un seul produit', () => {
    render(
      <ProductSalesStatistics
        orders={[order]}
        corrections={[]}
        products={products}
        now={new Date(2026, 8, 1, 12)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tout désélectionner' }))
    expect(screen.getByText('Sélectionnez au moins un produit.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Burger' }))
    expect(screen.getByRole('row', { name: /Burger/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /Frites/ })).not.toBeInTheDocument()
  })
})
