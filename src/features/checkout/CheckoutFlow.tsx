import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { printOrderTickets, type PrintOrderOptions } from '../../printing/orderPrintService'
import type { PrintJobResult, PrintSelection } from '../../printing/types'
import { createMockOrder } from '../../services/orderService'
import type { CartItem } from '../../types/cart'
import type { Order, PaymentMethod } from '../../types/order'
import { formatMoney } from '../../utils/money'

type Props = {
  items: CartItem[]
  onCancel: () => void
  onNewOrder: () => void
  printOrder?: (order: Order, options?: PrintOrderOptions) => Promise<PrintJobResult>
}

type Feedback = { kind: 'success' | 'error' | 'warning'; text: string }

export function CheckoutFlow({
  items,
  onCancel,
  onNewOrder,
  printOrder = printOrderTickets,
}: Props) {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card')
  const [printCustomerReceipt, setPrintCustomerReceipt] = useState(true)
  const [order, setOrder] = useState<Order | null>(null)
  const [completed, setCompleted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const printingRef = useRef(false)
  const totalCents = items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0)

  const runPrint = async (targetOrder: Order, options: PrintOrderOptions) => {
    if (printingRef.current) return
    printingRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const result = await printOrder(targetOrder, options)
      setCompleted(true)
      setFeedback(
        result.warnings.length
          ? { kind: 'warning', text: `Impression terminée. ${result.warnings.join(' ')}` }
          : {
              kind: 'success',
              text: 'Impression terminée : tous les tickets demandés ont été envoyés.',
            },
      )
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'L’impression a échoué. Vérifiez l’imprimante puis réessayez.',
      })
    } finally {
      printingRef.current = false
      setBusy(false)
    }
  }

  const checkoutAndPrint = () => {
    const targetOrder = order ?? createMockOrder(items, paymentMethod)
    if (!order) setOrder(targetOrder)
    void runPrint(targetOrder, { printCustomerReceipt })
  }

  const reprint = (selection: PrintSelection) => {
    if (!order) return
    void runPrint(order, { selection, printCustomerReceipt: true })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-title"
    >
      <section className="my-auto w-full max-w-2xl rounded-[12px] border border-stone-300 bg-[#fffdf8] p-5 sm:p-7">
        {!completed ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="checkout-title" className="text-3xl font-black">
                  Encaissement
                </h2>
                <p className="mt-1 font-bold text-stone-600">
                  {items.reduce((count, item) => count + item.quantity, 0)} article(s)
                </p>
              </div>
              <div className="text-4xl font-black tabular-nums">{formatMoney(totalCents)}</div>
            </div>

            <fieldset className="mt-6">
              <legend className="text-lg font-black">Mode de paiement</legend>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Button
                  className={`min-h-20 text-xl ${paymentMethod === 'card' ? 'outline-3 outline-offset-2 outline-[#1f6a4b]' : ''}`}
                  variant={paymentMethod === 'card' ? 'primary' : 'secondary'}
                  disabled={busy || order !== null}
                  aria-pressed={paymentMethod === 'card'}
                  onClick={() => setPaymentMethod('card')}
                >
                  Carte bancaire
                </Button>
                <Button
                  className={`min-h-20 text-xl ${paymentMethod === 'cash' ? 'outline-3 outline-offset-2 outline-[#1f6a4b]' : ''}`}
                  variant={paymentMethod === 'cash' ? 'primary' : 'secondary'}
                  disabled={busy || order !== null}
                  aria-pressed={paymentMethod === 'cash'}
                  onClick={() => setPaymentMethod('cash')}
                >
                  Espèces
                </Button>
              </div>
            </fieldset>

            <label className="mt-5 flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-stone-300 bg-white px-4 font-bold">
              <input
                type="checkbox"
                className="size-6 accent-[#1f6a4b]"
                checked={printCustomerReceipt}
                disabled={busy || order !== null}
                onChange={(event) => setPrintCustomerReceipt(event.target.checked)}
              />
              Imprimer le ticket client
              <span className="ml-auto text-xs text-stone-500">
                Le ticket préparation est toujours imprimé
              </span>
            </label>

            {order ? (
              <p className="mt-4 font-black text-[#1f6a4b]">
                Commande {order.orderNumber} · reçu {order.receiptNumber}
              </p>
            ) : null}

            {feedback ? <FeedbackBox feedback={feedback} /> : null}

            <div className="mt-6 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <Button disabled={busy} onClick={onCancel}>
                Retour
              </Button>
              <Button
                variant="primary"
                className="min-h-16 text-xl"
                disabled={busy}
                onClick={checkoutAndPrint}
              >
                {busy
                  ? 'Impression en cours…'
                  : order
                    ? 'Réessayer l’impression'
                    : 'Encaisser et imprimer'}
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <h2 id="checkout-title" className="text-3xl font-black">
              Commande validée
            </h2>
            <div className="mt-5 text-[clamp(5rem,15vw,9rem)] font-black leading-none tracking-tight text-[#1f6a4b]">
              {order?.orderNumber}
            </div>
            <div className="mt-3 text-4xl font-black tabular-nums">
              {formatMoney(order?.totalCents ?? totalCents)}
            </div>
            {feedback ? <FeedbackBox feedback={feedback} /> : null}

            <div className="mt-6 border-t border-stone-300 pt-5 text-left">
              <p className="mb-3 text-sm font-black text-stone-600">
                Réimpression — conserve les mêmes numéros
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button disabled={busy} onClick={() => reprint('both')}>
                  Les deux
                </Button>
                <Button disabled={busy} onClick={() => reprint('customer')}>
                  Ticket client
                </Button>
                <Button disabled={busy} onClick={() => reprint('preparation')}>
                  Préparation
                </Button>
              </div>
            </div>

            <Button
              variant="primary"
              fullWidth
              className="mt-6 min-h-16 text-xl"
              disabled={busy}
              onClick={onNewOrder}
            >
              Nouvelle commande
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}

function FeedbackBox({ feedback }: { feedback: Feedback }) {
  const colors =
    feedback.kind === 'error'
      ? 'bg-rose-50 text-rose-900'
      : feedback.kind === 'warning'
        ? 'bg-amber-50 text-amber-950'
        : 'bg-emerald-50 text-emerald-900'
  return (
    <div className={`mt-5 rounded-xl p-4 font-bold ${colors}`} role="status">
      {feedback.text}
    </div>
  )
}
