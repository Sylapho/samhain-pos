import { describe, expect, it } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { products } from '../mocks/products'
import { createCartItemDraft } from '../utils/cart'
import { renderCustomerReceipt } from './customerReceiptRenderer'
import { encodeCp858 } from './escPos'
import { wrapText } from './layout'
import { renderPreparationTicket } from './preparationTicketRenderer'

describe('rendus thermiques', () => {
  it('rend un ticket client complet avec paiement et TVA', () => {
    const ticket = renderCustomerReceipt(printPreviewOrder)
    expect(ticket.preview).toContain('SAMHAIN')
    expect(ticket.preview).toContain('Association Les Trouble-fêtes')
    expect(ticket.preview).toContain('A001')
    expect(ticket.preview).toContain('R-20260901-0001')
    expect(ticket.preview).toContain('01/09/2026')
    expect(ticket.preview).toContain('20:15')
    expect(ticket.preview).toContain('Burger spécial Samhain')
    expect(ticket.preview).toContain('32,00 €')
    expect(ticket.preview).toContain('Paiement : CB')
    expect(ticket.preview).toContain('TVA 10 %')
    expect(ticket.preview).toContain('TVA 20 %')
    expect(ticket.preview).toContain('TOTAL TTC 41,50 €')
    expect([...ticket.bytes].slice(0, 2)).toEqual([0x1b, 0x40])
  })

  it('rend une préparation lisible sans prix, paiement ni TVA', () => {
    const ticket = renderPreparationTicket(printPreviewOrder)
    expect(ticket.preview).toContain('A001')
    expect(ticket.preview).toContain('2 X BURGER SPÉCIAL SAMHAIN')
    expect(ticket.preview).not.toMatch(/€|Paiement|TVA|41,50/)
  })

  it('met très visiblement en avant les ingrédients retirés uniquement en préparation', () => {
    const burger = products.find((product) => product.id === 'burger-samhain')!
    const draft = createCartItemDraft(burger)
    const personalizedOrder = {
      ...printPreviewOrder,
      itemCount: 1,
      totalCents: draft.unitPriceCents,
      items: [
        {
          ...draft,
          lineId: 'burger-sans-cheddar-salade',
          quantity: 1,
          removedIngredientIds: ['cheddar', 'salade'],
        },
      ],
    }

    const preparation = renderPreparationTicket(personalizedOrder).preview
    expect(preparation).toContain('*** SANS CHEDDAR ***')
    expect(preparation).toContain('*** SANS SALADE ***')
    expect(renderCustomerReceipt(personalizedOrder).preview).not.toContain('SANS CHEDDAR')
  })

  it('imprime les groupes et choix du menu de façon explicite en préparation', () => {
    const menu = products.find((product) => product.id === 'menu-enfant')!
    const draft = createCartItemDraft(menu, {
      optionIdsByGroup: {
        plat: ['nuggets'],
        boisson: ['coca'],
        dessert: ['compote'],
      },
    })
    const menuOrder = {
      ...printPreviewOrder,
      itemCount: 1,
      totalCents: draft.unitPriceCents,
      items: [{ ...draft, lineId: 'menu-configure', quantity: 1 }],
    }

    const preparation = renderPreparationTicket(menuOrder).preview
    expect(preparation).toContain('PLAT : NUGGETS')
    expect(preparation).toContain('BOISSON : COCA-COLA')
    expect(preparation).toContain('DESSERT : COMPOTE')
  })

  it('limite toutes les lignes au nombre de colonnes demandé', () => {
    const lines = wrapText(
      'Bière pression Crêpe complète Café et produit exceptionnellement long avec beaucoup de détails',
      20,
    )
    expect(lines.every((line) => line.length <= 20)).toBe(true)
  })

  it('encode les accents français utilisés après passage en majuscules', () => {
    expect(encodeCp858('BIÈRE PRESSION · CRÊPE COMPLÈTE · CAFÉ')).not.toContain(0x3f)
  })
})
