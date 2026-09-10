import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { useCartStore } from '../store/cartStore'
import { App } from './App'

describe('caisse', () => {
  beforeEach(() => {
    useCartStore.getState().clearCart()
  })

  it('désactive la validation et l’annulation lorsque la commande est vide', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annuler la commande' })).toBeDisabled()
  })

  it('n’annonce pas l’imprimante prête avant la fin de la vérification réelle', async () => {
    let finishProbe: ((status: 'ready') => void) | undefined
    const probePrinterStatus = vi.fn(
      () =>
        new Promise<'ready'>((resolve) => {
          finishProbe = resolve
        }),
    )

    render(<App probePrinterStatus={probePrinterStatus} />)

    expect(screen.getByText('Imprimante : Vérification…')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Prête')).not.toBeInTheDocument()

    finishProbe?.('ready')
    expect(await screen.findByText('Imprimante : Prête')).toBeInTheDocument()
  })

  it('reflète une déconnexion détectée lors de la vérification suivante', async () => {
    vi.useFakeTimers()
    const probePrinterStatus = vi
      .fn<() => Promise<'ready' | 'disconnected'>>()
      .mockResolvedValueOnce('ready')
      .mockResolvedValue('disconnected')

    render(<App probePrinterStatus={probePrinterStatus} />)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Prête')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(screen.getByText('Imprimante : Déconnectée')).toBeInTheDocument())
    vi.useRealTimers()
  })

  it('affiche une erreur si la vérification matérielle échoue', async () => {
    render(<App probePrinterStatus={async () => Promise.reject(new Error('USB indisponible'))} />)

    expect(await screen.findByText('Imprimante : Vérification impossible')).toBeInTheDocument()
    expect(screen.queryByText('Imprimante : Prête')).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /25 cl/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter Coca-Cola' }))
    expect(screen.getByText('Taille : 25 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    fireEvent.click(screen.getByRole('button', { name: /50 cl/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.getByText('Taille : 25 cl')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personnaliser Coca-Cola' }))
    expect(screen.getByRole('button', { name: /25 cl/ })).toHaveAttribute('aria-pressed', 'true')
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
      'false',
    )
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Espèces' }))
    expect(screen.getByRole('button', { name: 'Espèces' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Montant exact/ }))
    expect(screen.getByRole('button', { name: 'Encaisser et imprimer' })).toBeEnabled()
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

  it('propose de reprendre une impression persistée après redémarrage', async () => {
    const partialOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'partial' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'failed' as const,
      },
    }

    render(<App loadRecoverableOrders={async () => [partialOrder]} />)

    expect(await screen.findByText('1 impression(s) à reprendre')).toBeInTheDocument()
    expect(screen.getByText('Commande A001 payée et enregistrée')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’impression' }))

    const checkout = screen.getByRole('dialog', { name: 'Encaissement' })
    expect(checkout).toBeInTheDocument()
    expect(
      screen.getByText('Paiement enregistré · impression partielle à reprendre'),
    ).toBeInTheDocument()
    expect(
      within(checkout).getByRole('button', { name: 'Reprendre l’impression' }),
    ).toBeInTheDocument()
  })

  it('consulte une ancienne commande sans modifier la commande active', async () => {
    const historicalOrder = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'printed' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'printed' as const,
      },
    }
    render(
      <App loadRecoverableOrders={async () => []} loadOrders={async () => [historicalOrder]} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Assiettes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Omelette, 10,00/ }))

    const activeOrder = screen.getByLabelText('Commande en cours')
    expect(within(activeOrder).getByText('Omelette')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Historique' }))
    expect(
      await screen.findByRole('dialog', { name: 'Historique des commandes' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Commande A001' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))

    expect(within(activeOrder).getByText('Omelette')).toBeInTheDocument()
    expect(within(activeOrder).getAllByText(/10,00/)).toHaveLength(3)
  })
})
