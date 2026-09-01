import { Button } from '../../components/ui/Button'
import { getCartItemCount, getCartTotalCents, useCartStore } from '../../store/cartStore'
import { formatMoney } from '../../utils/money'

type Props = { onCheckout: () => void }

export function CartPanel({ onCheckout }: Props) {
  const items = useCartStore((s) => s.items)
  const increment = useCartStore((s) => s.incrementItem)
  const decrement = useCartStore((s) => s.decrementItem)
  const remove = useCartStore((s) => s.removeItem)
  const total = getCartTotalCents(items)
  const count = getCartItemCount(items)

  return (
    <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white" aria-label="Commande en cours">
      <div className="border-b border-slate-200 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-2xl font-black">Commande</h2>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold">{count} article{count > 1 ? 's' : ''}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 ? (
          <div className="flex h-full min-h-48 items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center text-slate-500">
            <div><strong className="block text-lg text-slate-700">Panier vide</strong>Appuyez sur un produit pour l’ajouter.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.productId} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex justify-between gap-3">
                  <div className="font-extrabold leading-tight">{item.name}</div>
                  <div className="shrink-0 font-black tabular-nums">{formatMoney(item.unitPriceCents * item.quantity)}</div>
                </div>
                {item.priceIsMock ? <div className="mt-1 text-xs font-bold text-amber-800">Prix fictif</div> : null}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2" aria-label={`Quantité ${item.name}`}>
                    <button type="button" onClick={() => decrement(item.productId)} aria-label={`Diminuer ${item.name}`} className="h-12 w-12 rounded-xl border border-slate-300 text-2xl font-black focus-visible:outline-3 focus-visible:outline-sky-600">−</button>
                    <span className="min-w-10 text-center text-xl font-black tabular-nums">{item.quantity}</span>
                    <button type="button" onClick={() => increment(item.productId)} aria-label={`Augmenter ${item.name}`} className="h-12 w-12 rounded-xl border border-slate-300 text-2xl font-black focus-visible:outline-3 focus-visible:outline-sky-600">+</button>
                  </div>
                  <Button variant="danger" className="px-3" onClick={() => remove(item.productId)}>Supprimer</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 bg-slate-50 p-5">
        <div className="flex items-end justify-between gap-3">
          <span className="text-sm font-black uppercase tracking-wider text-slate-500">Total</span>
          <span className="text-4xl font-black tabular-nums text-slate-950">{formatMoney(total)}</span>
        </div>
        <Button variant="primary" fullWidth className="mt-4 min-h-16 text-xl" disabled={!items.length} onClick={onCheckout}>Encaisser</Button>
      </div>
    </aside>
  )
}
