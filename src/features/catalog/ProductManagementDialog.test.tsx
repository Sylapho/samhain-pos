import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { initialCatalogProducts } from '../../data/initialCatalog'
import { IndexedDbCatalogRepository } from '../../services/catalogRepository'
import { CatalogService } from '../../services/catalogService'
import type { Category, Product } from '../../types/catalog'
import { ProductManagementDialog } from './ProductManagementDialog'

async function setup() {
  const repository = new IndexedDbCatalogRepository(new IDBFactory(), 'admin')
  const service = new CatalogService(repository, initialCatalogProducts.slice(0, 2))
  const products = await service.loadCatalog()
  return { repository, service, products, categories: await service.getCategories() }
}
function Administration({
  service,
  products: initialProducts,
  categories: initialCategories,
}: {
  service: CatalogService
  products: Product[]
  categories: Category[]
}) {
  const [products, setProducts] = useState(initialProducts)
  const [categories, setCategories] = useState(initialCategories)
  return (
    <ProductManagementDialog
      products={products}
      categories={categories}
      service={service}
      onProductsChanged={setProducts}
      onCategoriesChanged={setCategories}
      onClose={vi.fn()}
    />
  )
}

describe('Administration du catalogue', () => {
  it('affiche la confirmation migrée et permet de la retirer durablement', async () => {
    const state = await setup()
    render(<Administration {...state} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Modifier' })[0]!)
    const checkbox = screen.getByRole('checkbox', {
      name: 'Prix, TVA et composition vérifiés pour publication',
    })
    expect(checkbox).toBeChecked()
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', {
          name: 'Prix, TVA et composition vérifiés pour publication',
        }),
      ).not.toBeInTheDocument(),
    )
    await state.service.loadCatalog()
    expect((await state.service.getProducts())[0]?.dataConfidence).toBe('temporary')
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un produit' }))
    expect(
      screen.getByRole('checkbox', { name: 'Prix, TVA et composition vérifiés pour publication' }),
    ).not.toBeChecked()
  })

  it('crée un produit et désactive puis réactive sans suppression', async () => {
    const state = await setup()
    render(<Administration {...state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un produit' }))
    expect(
      screen.getByRole('checkbox', { name: 'Prix, TVA et composition vérifiés pour publication' }),
    ).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Soupe' } })
    fireEvent.change(screen.getByLabelText('Prix TTC (€)'), { target: { value: '4,50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Soupe')
    expect(await state.service.getProducts()).toContainEqual(
      expect.objectContaining({ name: 'Soupe', priceCents: 450 }),
    )
    expect(
      (await state.service.loadCatalog()).find(({ name }) => name === 'Soupe')?.dataConfidence,
    ).not.toBe('confirmed')
    fireEvent.click(screen.getAllByRole('button', { name: 'Désactiver' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Réactiver' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Réactiver' })).not.toBeInTheDocument(),
    )
    expect(await state.service.getProducts()).toHaveLength(3)
  })

  it('crée, valide, renomme, réordonne et désactive une catégorie puis met à jour le formulaire produit', async () => {
    const state = await setup()
    render(<Administration {...state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Catégories' }))
    expect(screen.getByRole('dialog', { name: 'Catégories' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une catégorie' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nom de la catégorie est requis')
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), {
      target: { value: ' BIÈRES ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('déjà ce nom')
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), {
      target: { value: 'Nouveautés' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    const row = await screen.findByRole('listitem', { name: 'Nouveautés' })
    fireEvent.click(within(row).getByRole('button', { name: 'Renommer' }))
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), {
      target: { value: 'Spécialités' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    const renamed = await screen.findByRole('listitem', { name: 'Spécialités' })
    fireEvent.click(within(renamed).getByRole('button', { name: 'Monter' }))
    await waitFor(() =>
      expect(within(renamed).getByRole('heading')).toHaveTextContent('6. Spécialités'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Produits' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un produit' }))
    expect(screen.getByRole('option', { name: 'Spécialités' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Catégorie'), {
      target: {
        value: (await state.service.getCategories()).find(({ label }) => label === 'Spécialités')!
          .id,
      },
    })
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Produit spécial' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Produit spécial')
    fireEvent.click(screen.getByRole('button', { name: 'Catégories' }))
    fireEvent.click(
      within(screen.getByRole('listitem', { name: 'Spécialités' })).getByRole('button', {
        name: 'Désactiver',
      }),
    )
    await screen.findByRole('button', { name: 'Réactiver' })
    fireEvent.click(screen.getByRole('button', { name: 'Produits' }))
    const article = screen.getByText('Produit spécial').closest('article')!
    fireEvent.click(within(article).getByRole('button', { name: 'Modifier' }))
    expect(screen.getByRole('option', { name: 'Spécialités (inactive)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Modifier Produit spécial' }),
      ).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un produit' }))
    expect(screen.queryByRole('option', { name: /Spécialités/ })).not.toBeInTheDocument()
  })

  it('explique l’absence de catégories actives et empêche la création de produit', async () => {
    const state = await setup()
    for (const category of state.categories)
      await state.service.setCategoryActive(category.id, false)
    render(<Administration {...state} categories={await state.service.getCategories()} />)
    expect(screen.getByRole('button', { name: 'Ajouter un produit' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Aucune catégorie active')
  })

  it('bloque les doubles validations et la fermeture pendant une écriture', async () => {
    const state = await setup()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const create = vi.spyOn(state.service, 'createCategory').mockImplementation(async () => {
      await gate
      return { id: 'pending', label: 'En attente', active: true, displayOrder: 6 }
    })
    render(<Administration {...state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Catégories' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une catégorie' }))
    fireEvent.change(screen.getByLabelText('Nom de la catégorie'), {
      target: { value: 'En attente' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Enregistrement')
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fermer' })).toBeEnabled())
  })
})
