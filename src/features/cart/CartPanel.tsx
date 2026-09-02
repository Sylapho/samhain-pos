import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { ProductOptionsSheet } from '../catalog/ProductOptionsSheet'
import { getCartItemCount, getCartTotalCents, useCartStore } from '../../store/cartStore'
import type { Product } from '../../types/catalog'
import {
  createCartItemDraft,
  getCartItemProductSelection,
  getRemovedIngredients,
} from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type Props = { onCheckout: () => void; products: Product[] }

export function CartPanel({ onCheckout, products }: Props) {
  const [cancelOpen, setCancelOpen] = useState(false)
  const [customizingLineId, setCustomizingLineId] = useState<string | null>(null)
  const items = useCartStore((state) => state.items)
  const increment = useCartStore((state) => state.incrementItem)
  const decrement = useCartStore((state) => state.decrementItem)
  const remove = useCartStore((state) => state.removeItem)
  const configure = useCartStore((state) => state.configureItem)
  const clearCart = useCartStore((state) => state.clearCart)
  const total = getCartTotalCents(items)
  const count = getCartItemCount(items)
  const customizingItem = items.find((item) => item.lineId === customizingLineId) ?? null
  const customizingProduct = customizingItem
    ? (products.find((product) => product.id === customizingItem.productId) ?? null)
    : null

  const confirmCancellation = () => {
    clearCart()
    setCancelOpen(false)
  }

  return (
    <>
      <aside
        className="flex min-h-0 flex-col border-l border-stone-300 bg-[#fffdf8]"
        aria-label="Commande en cours"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-stone-300 px-4 py-3">
          <h2 className="text-2xl font-black">Commande</h2>
          <span className="font-bold text-stone-600">
            {count} article{count > 1 ? 's' : ''}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <div className="flex h-full min-h-44 items-center justify-center border-y border-dashed border-stone-300 p-5 text-center text-stone-600">
              <div>
                <strong className="block text-lg text-stone-800">Commande vide</strong>
                Touchez un produit pour l’ajouter.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-stone-300">
              {items.map((item) => {
                const removedIngredients = getRemovedIngredients(item)
                const product = products.find((candidate) => candidate.id === item.productId)
                const configurable = Boolean(
                  product &&
                  (product.variants?.length ||
                    product.optionGroups?.length ||
                    product.ingredients?.length),
                )
                const hasProductChoices = Boolean(
                  product && (product.variants?.length || product.optionGroups?.length),
                )
                const overview = (
                  <div className="flex w-full justify-between gap-3 text-left">
                    <div className="min-w-0">
                      <div className="font-black leading-tight">{item.name}</div>
                      {item.variant ? (
                        <div className="mt-1 text-sm font-bold text-stone-700">
                          {item.variant.name}
                          {item.variant.volume ? ` · ${item.variant.volume}` : ''}
                        </div>
                      ) : null}
                      {item.options.map((option) => (
                        <div
                          key={option.groupId}
                          className="mt-1 text-sm leading-snug text-stone-600"
                        >
                          {option.groupName} : {option.optionName}
                        </div>
                      ))}
                      {removedIngredients.map((ingredient) => (
                        <div
                          key={ingredient.id}
                          className="mt-1 text-sm font-extrabold text-amber-800"
                        >
                          Sans {ingredient.name.toLocaleLowerCase('fr-FR')}
                        </div>
                      ))}
                      {configurable ? (
                        <div className="mt-2 text-xs font-extrabold text-[#185b40] underline underline-offset-2">
                          {hasProductChoices ? 'Modifier les choix' : 'Modifier la composition'}
                        </div>
                      ) : null}
                      <div className="mt-2 text-xs font-semibold text-stone-500">
                        {formatMoney(item.unitPriceCents)} l’unité
                      </div>
                    </div>
                    <div className="shrink-0 text-lg font-black tabular-nums">
                      {formatMoney(item.unitPriceCents * item.quantity)}
                    </div>
                  </div>
                )

                return (
                  <article key={item.lineId} className="py-4 first:pt-1">
                    {configurable ? (
                      <button
                        type="button"
                        className="w-full rounded-lg p-1 focus-visible:outline-3 focus-visible:outline-[#216a9a]"
                        aria-label={`Personnaliser ${item.name}`}
                        onClick={() => setCustomizingLineId(item.lineId)}
                      >
                        {overview}
                      </button>
                    ) : (
                      overview
                    )}
                    {item.dataConfidence === 'temporary' ? (
                      <div className="mt-2 text-xs font-bold text-amber-800">
                        Donnée métier temporaire
                      </div>
                    ) : null}
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1" aria-label={`Quantité ${item.name}`}>
                        <button
                          type="button"
                          onClick={() => decrement(item.lineId)}
                          aria-label={`Diminuer ${item.name}`}
                          className="h-12 w-12 rounded-[8px] border border-stone-400 bg-white text-2xl font-black active:bg-stone-100 focus-visible:outline-3 focus-visible:outline-[#216a9a]"
                        >
                          −
                        </button>
                        <span className="min-w-10 text-center text-xl font-black tabular-nums">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => increment(item.lineId)}
                          aria-label={`Augmenter ${item.name}`}
                          className="h-12 w-12 rounded-[8px] border border-stone-400 bg-white text-2xl font-black active:bg-stone-100 focus-visible:outline-3 focus-visible:outline-[#216a9a]"
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(item.lineId)}
                        className="min-h-12 px-2 text-sm font-extrabold text-red-800 underline decoration-red-300 underline-offset-4 focus-visible:outline-3 focus-visible:outline-[#216a9a]"
                      >
                        Supprimer
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t-2 border-stone-400 bg-[#f6f1e7] p-4">
          <div className="flex items-end justify-between gap-3">
            <span className="text-sm font-black uppercase tracking-wider text-stone-600">
              Total
            </span>
            <span className="text-4xl font-black tabular-nums text-stone-950">
              {formatMoney(total)}
            </span>
          </div>
          <Button
            variant="primary"
            fullWidth
            className="mt-4 min-h-16 text-xl"
            disabled={!items.length}
            onClick={onCheckout}
          >
            Valider la commande
          </Button>
          <Button
            variant="danger"
            fullWidth
            className="mt-2"
            disabled={!items.length}
            onClick={() => setCancelOpen(true)}
          >
            Annuler la commande
          </Button>
        </div>
      </aside>

      {cancelOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/65 p-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
        >
          <div className="w-full max-w-lg rounded-[12px] border border-stone-300 bg-[#fffdf8] p-6">
            <h2 id="cancel-title" className="text-2xl font-black">
              Annuler cette commande ?
            </h2>
            <p className="mt-2 text-stone-600">
              Tous les produits de la commande en cours seront retirés.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Button onClick={() => setCancelOpen(false)}>Retour</Button>
              <Button variant="danger" onClick={confirmCancellation}>
                Annuler la commande
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {customizingItem && customizingProduct ? (
        <ProductOptionsSheet
          key={customizingItem.lineId}
          product={customizingProduct}
          mode="edit"
          quantity={customizingItem.quantity}
          initialSelection={getCartItemProductSelection(customizingItem)}
          initialRemovedIngredientIds={customizingItem.removedIngredientIds}
          onCancel={() => setCustomizingLineId(null)}
          onConfirm={(selection, removedIngredientIds) => {
            configure(
              customizingItem.lineId,
              createCartItemDraft(customizingProduct, selection, removedIngredientIds),
            )
            setCustomizingLineId(null)
          }}
        />
      ) : null}
    </>
  )
}
