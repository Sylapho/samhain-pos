import { useState } from 'react'
import type { Product } from '../../types/catalog'
import { Button } from '../../components/ui/Button'
import { formatMoney } from '../../utils/money'

type ProductOptionsSheetProps = {
  product: Product
  onCancel: () => void
  onConfirm: (product: Product) => void
}

const dishes = ['Saucisse', 'Steak haché'] as const
const drinks = ['Eau', 'Jus de fruit'] as const

export function ProductOptionsSheet({ product, onCancel, onConfirm }: ProductOptionsSheetProps) {
  const [dish, setDish] = useState<(typeof dishes)[number]>('Saucisse')
  const [drink, setDrink] = useState<(typeof drinks)[number]>('Eau')

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/55 p-6" role="dialog" aria-modal="true" aria-labelledby="options-title">
      <div className="w-full max-w-3xl rounded-3xl bg-white p-7 shadow-2xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-extrabold uppercase tracking-wide text-slate-500">Prototype d’options</p>
            <h2 id="options-title" className="mt-1 text-3xl font-black text-slate-950">{product.name}</h2>
            <p className="mt-2 text-lg font-bold text-slate-700">{formatMoney(product.priceCents)}</p>
          </div>
          <Button variant="quiet" onClick={onCancel}>Fermer</Button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <fieldset>
            <legend className="mb-3 text-lg font-black">Plat</legend>
            <div className="grid gap-3">
              {dishes.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={dish === option}
                  onClick={() => setDish(option)}
                  className={`min-h-16 rounded-xl border px-4 text-left text-lg font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${dish === option ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-3 text-lg font-black">Boisson</legend>
            <div className="grid gap-3">
              {drinks.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={drink === option}
                  onClick={() => setDrink(option)}
                  className={`min-h-16 rounded-xl border px-4 text-left text-lg font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${drink === option ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-7 rounded-2xl bg-slate-100 p-4 text-slate-700">
          <strong>Choix :</strong> {dish} · {drink}
          <div className="mt-1 text-sm">Hypothèse UX uniquement : ces options ne sont pas encore persistées dans le panier.</div>
        </div>
        <Button variant="primary" fullWidth className="mt-5 min-h-16 text-xl" onClick={() => onConfirm(product)}>
          Ajouter ce menu
        </Button>
      </div>
    </div>
  )
}
