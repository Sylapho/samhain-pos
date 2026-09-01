import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { CartItem } from '../../types/cart'

type Props = {
  item: CartItem
  onCancel: () => void
  onConfirm: (removedIngredientIds: string[]) => void
}

export function ProductCustomizationSheet({ item, onCancel, onConfirm }: Props) {
  const [presentIngredientIds, setPresentIngredientIds] = useState(
    () =>
      new Set(
        item.ingredients
          .filter((ingredient) => !item.removedIngredientIds.includes(ingredient.id))
          .map((ingredient) => ingredient.id),
      ),
  )

  const toggleIngredient = (ingredientId: string) => {
    setPresentIngredientIds((current) => {
      const next = new Set(current)
      if (next.has(ingredientId)) next.delete(ingredientId)
      else next.add(ingredientId)
      return next
    })
  }

  const confirm = () => {
    onConfirm(
      item.ingredients
        .filter((ingredient) => !presentIngredientIds.has(ingredient.id))
        .map((ingredient) => ingredient.id),
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/65 sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="customization-title"
    >
      <section className="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-stone-300 bg-[#fffdf8] sm:rounded-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-stone-300 bg-[#fffdf8] p-5">
          <div>
            <h2 id="customization-title" className="text-3xl font-black leading-tight">
              {item.name}
            </h2>
            <p className="mt-1 font-bold text-stone-600">Composition</p>
          </div>
          <Button variant="quiet" onClick={onCancel}>
            Fermer
          </Button>
        </header>

        <fieldset className="grid gap-3 p-5 sm:grid-cols-2">
          <legend className="sr-only">Ingrédients présents</legend>
          {item.ingredients.map((ingredient) => {
            const present = presentIngredientIds.has(ingredient.id)
            return (
              <label
                key={ingredient.id}
                className={`flex min-h-18 cursor-pointer items-center gap-4 rounded-xl border-2 px-4 py-3 text-lg font-black active:bg-stone-100 ${
                  present
                    ? 'border-[#315d48] bg-[#edf5f0]'
                    : 'border-amber-400 bg-amber-50 text-amber-950'
                }`}
              >
                <input
                  type="checkbox"
                  className="size-7 shrink-0 accent-[#1f6a4b]"
                  checked={present}
                  onChange={() => toggleIngredient(ingredient.id)}
                />
                <span>{ingredient.name}</span>
                {!present ? (
                  <span className="ml-auto text-sm uppercase" aria-hidden="true">
                    Retiré
                  </span>
                ) : null}
              </label>
            )
          })}
        </fieldset>

        {item.quantity > 1 ? (
          <p className="mx-5 rounded-xl bg-sky-50 p-3 font-bold text-sky-950">
            La modification s’appliquera à un seul {item.name}. La quantité sera séparée en deux
            lignes.
          </p>
        ) : null}

        <footer className="sticky bottom-0 mt-5 grid grid-cols-2 gap-3 border-t border-stone-300 bg-[#f6f1e7] p-5">
          <Button className="min-h-16 text-lg" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" className="min-h-16 text-xl" onClick={confirm}>
            Valider
          </Button>
        </footer>
      </section>
    </div>
  )
}
