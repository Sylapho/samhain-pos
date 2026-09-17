import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { initialCatalogProducts } from '../../data/initialCatalog'
import type { CatalogRepository } from '../../services/catalogRepository'
import { CatalogService } from '../../services/catalogService'
import type { Product } from '../../types/catalog'
import { ProductManagementDialog } from './ProductManagementDialog'

class MemoryCatalogRepository implements CatalogRepository {
  products = structuredClone(initialCatalogProducts.slice(0, 2))

  async initialize() {
    return { initialized: false, products: structuredClone(this.products) }
  }

  async getProducts() {
    return structuredClone(this.products)
  }

  async getSellableProducts() {
    return structuredClone(
      this.products.filter(({ active, availability }) => active && availability === 'available'),
    )
  }

  async createProduct(product: Product) {
    this.products.push(structuredClone(product))
    return structuredClone(product)
  }

  async updateProduct(product: Product) {
    this.products = this.products.map((candidate) =>
      candidate.id === product.id ? structuredClone(product) : candidate,
    )
    return structuredClone(product)
  }
}

describe('Administration → Produits', () => {
  it('crée un produit validé et le publie dans le catalogue courant', async () => {
    const repository = new MemoryCatalogRepository()
    const service = new CatalogService(repository, [])
    const onProductsChanged = vi.fn()
    render(
      <ProductManagementDialog
        products={repository.products}
        service={service}
        onProductsChanged={onProductsChanged}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un produit' }))
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Soupe' } })
    fireEvent.change(screen.getByLabelText('Prix TTC (€)'), { target: { value: '4,50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(repository.products.at(-1)).toMatchObject({ name: 'Soupe', priceCents: 450 }),
    )
    expect(onProductsChanged).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'Soupe', priceCents: 450 })]),
    )
  })

  it('désactive puis réactive un produit sans le supprimer', async () => {
    const repository = new MemoryCatalogRepository()
    const service = new CatalogService(repository, [])
    const { rerender } = render(
      <ProductManagementDialog
        products={repository.products}
        service={service}
        onProductsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Désactiver' })[0]!)
    await waitFor(() => expect(repository.products[0]?.active).toBe(false))
    rerender(
      <ProductManagementDialog
        products={repository.products}
        service={service}
        onProductsChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Réactiver' }))
    await waitFor(() => expect(repository.products[0]?.active).toBe(true))
  })
})
