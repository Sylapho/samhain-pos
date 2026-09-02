import { beforeEach, describe, expect, it } from 'vitest'
import { products } from '../mocks/products'
import type { Product } from '../types/catalog'
import { createCartItemDraft, getDefaultProductSelection } from '../utils/cart'
import { getCartTotalCents, useCartStore } from './cartStore'

const burger = products.find((product) => product.id === 'burger-samhain')!
const prestige = products.find((product) => product.id === 'biere-prestige')!
const tea = products.find((product) => product.id === 'the')!
const coca = products.find((product) => product.id === 'cola-temporaire')!
const configurableSnack: Product = {
  id: 'snack-configurable-test',
  name: 'Snack configurable',
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
        { id: 'petit', name: 'Petit' },
        { id: 'grand', name: 'Grand', priceDeltaCents: 200 },
      ],
    },
    {
      id: 'supplements',
      name: 'Suppléments',
      type: 'multiple',
      required: false,
      options: [
        { id: 'bacon', name: 'Bacon', priceDeltaCents: 100 },
        { id: 'cheddar', name: 'Cheddar', priceDeltaCents: 50 },
      ],
    },
  ],
}

describe('cart store', () => {
  beforeEach(() => useCartStore.getState().clearCart())

  it('fusionne deux lignes strictement identiques', () => {
    const draft = createCartItemDraft(burger)
    useCartStore.getState().addItem(draft)
    useCartStore.getState().addItem(draft)
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0]?.quantity).toBe(2)
  })

  it('sépare deux variantes différentes', () => {
    useCartStore
      .getState()
      .addItem(createCartItemDraft(prestige, { variantId: '25cl', optionIdsByGroup: {} }))
    useCartStore
      .getState()
      .addItem(createCartItemDraft(prestige, { variantId: '50cl', optionIdsByGroup: {} }))
    expect(useCartStore.getState().items).toHaveLength(2)
  })

  it('sépare deux options différentes', () => {
    useCartStore
      .getState()
      .addItem(createCartItemDraft(tea, { optionIdsByGroup: { parfum: ['menthe'] } }))
    useCartStore
      .getState()
      .addItem(createCartItemDraft(tea, { optionIdsByGroup: { parfum: ['fruits-rouges'] } }))
    expect(useCartStore.getState().items).toHaveLength(2)
  })

  it('fusionne uniquement les produits ayant la même personnalisation', () => {
    const normal = createCartItemDraft(burger)
    const withoutCheddar = { ...normal, removedIngredientIds: ['cheddar'] }

    useCartStore.getState().addItem(normal)
    useCartStore.getState().addItem(withoutCheddar)
    useCartStore.getState().addItem(withoutCheddar)

    expect(useCartStore.getState().items).toHaveLength(2)
    expect(
      useCartStore.getState().items.find((item) => item.removedIngredientIds.includes('cheddar'))
        ?.quantity,
    ).toBe(2)
  })

  it('sépare une seule unité personnalisée puis la fusionne si elle redevient identique', () => {
    const normal = createCartItemDraft(burger)
    useCartStore.getState().addItem(normal)
    useCartStore.getState().addItem(normal)
    const normalLineId = useCartStore.getState().items[0]!.lineId

    const selection = getDefaultProductSelection(burger)
    useCartStore
      .getState()
      .configureItem(normalLineId, createCartItemDraft(burger, selection, ['cheddar']))
    expect(useCartStore.getState().items).toHaveLength(2)
    expect(useCartStore.getState().items.map((item) => item.quantity)).toEqual([1, 1])
    expect(getCartTotalCents(useCartStore.getState().items)).toBe(3200)

    const customizedLineId = useCartStore
      .getState()
      .items.find((item) => item.removedIngredientIds.includes('cheddar'))!.lineId
    useCartStore.getState().configureItem(customizedLineId, createCartItemDraft(burger, selection))
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0]?.quantity).toBe(2)
    expect(useCartStore.getState().items[0]?.removedIngredientIds).toEqual([])
  })

  it('fusionne les mêmes tailles et sépare deux tailles différentes avec leur prix', () => {
    const defaultSelection = getDefaultProductSelection(coca)
    const fiftyClSelection = { optionIdsByGroup: { taille: ['50cl'] } }
    useCartStore.getState().addItem(createCartItemDraft(coca, defaultSelection))
    useCartStore.getState().addItem(createCartItemDraft(coca, defaultSelection))
    const defaultLineId = useCartStore.getState().items[0]!.lineId
    useCartStore
      .getState()
      .configureItem(defaultLineId, createCartItemDraft(coca, fiftyClSelection))
    useCartStore.getState().addItem(createCartItemDraft(coca, fiftyClSelection))

    expect(useCartStore.getState().items).toHaveLength(2)
    const defaultLine = useCartStore
      .getState()
      .items.find((item) => item.options.some((option) => option.optionId === '33cl'))
    const largeLine = useCartStore
      .getState()
      .items.find((item) => item.options.some((option) => option.optionId === '50cl'))
    expect(defaultLine).toMatchObject({ quantity: 1, unitPriceCents: 350 })
    expect(largeLine).toMatchObject({ quantity: 2, unitPriceCents: 450 })
  })

  it('valide les groupes obligatoires et additionne plusieurs choix facultatifs', () => {
    expect(() => createCartItemDraft(configurableSnack)).toThrow('Taille')
    const configured = createCartItemDraft(configurableSnack, {
      optionIdsByGroup: {
        taille: ['grand'],
        supplements: ['cheddar', 'bacon'],
      },
    })
    expect(configured.unitPriceCents).toBe(1350)
    expect(configured.options.map((option) => option.optionId)).toEqual([
      'grand',
      'bacon',
      'cheddar',
    ])
  })

  it('diminue, supprime à zéro et supprime explicitement', () => {
    useCartStore.getState().addItem(createCartItemDraft(burger))
    const lineId = useCartStore.getState().items[0]!.lineId
    useCartStore.getState().incrementItem(lineId)
    useCartStore.getState().decrementItem(lineId)
    expect(useCartStore.getState().items[0]?.quantity).toBe(1)
    useCartStore.getState().removeItem(lineId)
    expect(useCartStore.getState().items).toHaveLength(0)
  })

  it('calcule le total en centimes puis réinitialise la commande', () => {
    useCartStore.getState().addItem(createCartItemDraft(burger))
    useCartStore.getState().addItem(createCartItemDraft(burger))
    expect(getCartTotalCents(useCartStore.getState().items)).toBe(3200)
    useCartStore.getState().clearCart()
    expect(useCartStore.getState().items).toEqual([])
  })
})
