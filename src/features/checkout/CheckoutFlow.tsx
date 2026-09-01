import { Button } from '../../components/ui/Button'
import type { Order } from '../../types/order'
import { formatMoney } from '../../utils/money'

type Props = {
  order: Order
  onNewOrder: () => void
}

export function CheckoutFlow({ order, onNewOrder }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
    >
      <section className="w-full max-w-2xl rounded-[12px] border border-stone-300 bg-[#fffdf8] p-6 text-center sm:p-8">
        <h2 id="confirmation-title" className="text-3xl font-black">
          Commande validée
        </h2>
        <div className="mt-5 text-[clamp(5rem,15vw,9rem)] font-black leading-none tracking-tight text-[#1f6a4b]">
          {order.orderNumber}
        </div>
        <div className="mt-4 text-4xl font-black tabular-nums">{formatMoney(order.totalCents)}</div>
        <p className="mt-3 text-lg font-bold text-stone-600">
          {order.itemCount} article{order.itemCount > 1 ? 's' : ''} enregistré
          {order.itemCount > 1 ? 's' : ''}
        </p>
        <div className="mx-auto mt-6 max-w-md border-y border-stone-300 py-4 text-left">
          {order.items.map((item) => (
            <div key={item.lineId} className="flex justify-between gap-3 py-1 text-sm">
              <span className="min-w-0 truncate">
                {item.quantity} × {item.name}
                {item.variant ? ` · ${item.variant.name}` : ''}
              </span>
              <strong className="shrink-0 tabular-nums">
                {formatMoney(item.unitPriceCents * item.quantity)}
              </strong>
            </div>
          ))}
        </div>
        <p className="mt-5 text-sm text-stone-600">
          Le numéro de commande est prêt pour le ticket client.
        </p>
        <Button variant="primary" fullWidth className="mt-6 min-h-16 text-xl" onClick={onNewOrder}>
          Nouvelle commande
        </Button>
      </section>
    </div>
  )
}
