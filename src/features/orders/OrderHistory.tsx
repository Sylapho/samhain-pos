import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { formatTicketDateTime, paymentMethodLabels } from '../../printing/format'
import {
  getCompletedDocumentsFromPrintError,
  printOrderTickets,
  type PrintOrderOptions,
} from '../../printing/orderPrintService'
import type { PrintJobResult, PrintSelection } from '../../printing/types'
import {
  getPersistedOrders,
  orderLifecycle as persistedOrderLifecycle,
} from '../../services/orderService'
import type { CartItem } from '../../types/cart'
import type { Order, OrderPrintStatus, PrintDocumentStatus } from '../../types/order'
import { getRemovedIngredients } from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type Props = {
  onClose: () => void
  loadOrders?: typeof getPersistedOrders
  printOrder?: (order: Order, options?: PrintOrderOptions) => Promise<PrintJobResult>
  lifecycle?: typeof persistedOrderLifecycle
  onOrderUpdated?: (order: Order) => void
}

type Feedback = { kind: 'success' | 'error' | 'warning'; text: string }

const printStatusLabels: Record<OrderPrintStatus, string> = {
  pending: 'À imprimer',
  partial: 'Partielle',
  printed: 'Imprimée',
  failed: 'Échec',
  unknown: 'À vérifier',
}

const documentStatusLabels: Record<PrintDocumentStatus, string> = {
  not_requested: 'Non demandé',
  pending: 'À imprimer',
  printed: 'Imprimé',
  failed: 'Échec — à reprendre',
  unknown: 'À vérifier avant réimpression',
}

export function OrderHistory({
  onClose,
  loadOrders = getPersistedOrders,
  printOrder = printOrderTickets,
  lifecycle = persistedOrderLifecycle,
  onOrderUpdated,
}: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [printing, setPrinting] = useState<PrintSelection | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const printingRef = useRef(false)
  const selectedOrder = orders.find((order) => order.id === selectedOrderId) ?? null

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const persistedOrders = await loadOrders()
        if (!active) return
        setOrders(persistedOrders)
        setSelectedOrderId((current) =>
          current && persistedOrders.some((order) => order.id === current)
            ? current
            : (persistedOrders[0]?.id ?? null),
        )
      } catch {
        if (active) setLoadError(true)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [loadOrders])

  const storeUpdatedOrder = (updatedOrder: Order) => {
    setOrders((current) =>
      current.map((order) => (order.id === updatedOrder.id ? updatedOrder : order)),
    )
    onOrderUpdated?.(updatedOrder)
    return updatedOrder
  }

  const reprint = async (selection: PrintSelection) => {
    if (!selectedOrder || printingRef.current) return
    printingRef.current = true
    setPrinting(selection)
    setFeedback(null)

    const trackLifecycle = selectedOrder.printing.status !== 'printed'
    let printingOrder = selectedOrder

    try {
      if (trackLifecycle) {
        try {
          printingOrder = storeUpdatedOrder(
            await lifecycle.beginPrinting(selectedOrder.id, selection),
          )
        } catch {
          setFeedback({
            kind: 'error',
            text: `Commande ${selectedOrder.orderNumber} conservée. Aucun ticket n’a été lancé car l’état de reprise n’a pas pu être sauvegardé.`,
          })
          return
        }
      }

      let result: PrintJobResult
      try {
        result = await printOrder(printingOrder, {
          selection,
          printCustomerReceipt: true,
          reprint: true,
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'La réimpression a échoué. Vérifiez l’imprimante puis réessayez.'
        if (trackLifecycle) {
          try {
            storeUpdatedOrder(
              await lifecycle.failPrinting(
                selectedOrder.id,
                selection,
                getCompletedDocumentsFromPrintError(error, { selection }),
                message,
              ),
            )
          } catch {
            setFeedback({
              kind: 'error',
              text: `Commande ${selectedOrder.orderNumber} conservée. La réimpression a pu démarrer, mais son état n’a pas pu être sauvegardé. Vérifiez les tickets sortis avant de relancer.`,
            })
            return
          }
        }
        setFeedback({
          kind: 'error',
          text: `Commande ${selectedOrder.orderNumber} conservée. ${message}`,
        })
        return
      }

      if (trackLifecycle) {
        try {
          storeUpdatedOrder(
            await lifecycle.completePrinting(
              selectedOrder.id,
              selection,
              result.completedDocuments,
            ),
          )
        } catch {
          setFeedback({
            kind: 'warning',
            text: `Les tickets ont été envoyés, mais leur état n’a pas pu être sauvegardé. Vérifiez les tickets sortis avant de relancer.`,
          })
          return
        }
      }

      setFeedback({
        kind: result.warnings.length ? 'warning' : 'success',
        text: result.warnings.length
          ? `Réimpression terminée. ${result.warnings.join(' ')}`
          : `Réimpression terminée pour la commande ${selectedOrder.orderNumber}.`,
      })
    } finally {
      printingRef.current = false
      setPrinting(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/70 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-history-title"
    >
      <section className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[12px] border border-stone-300 bg-[#fffdf8] sm:max-h-[calc(100dvh-2.5rem)]">
        <header className="flex items-center justify-between gap-4 border-b border-stone-300 px-4 py-3 sm:px-5">
          <div>
            <h2 id="order-history-title" className="text-2xl font-black">
              Historique des commandes
            </h2>
            <p className="text-sm font-bold text-stone-600">
              Commandes enregistrées sur cette caisse
            </p>
          </div>
          <Button disabled={printing !== null} onClick={onClose}>
            Fermer
          </Button>
        </header>

        {loading ? (
          <p className="p-6 font-bold" role="status">
            Chargement de l’historique…
          </p>
        ) : loadError ? (
          <p
            className="m-5 border border-rose-300 bg-rose-50 p-4 font-bold text-rose-950"
            role="alert"
          >
            L’historique local est indisponible. Fermez cette vue puis réessayez.
          </p>
        ) : orders.length === 0 ? (
          <p className="p-6 font-bold text-stone-700">Aucune commande enregistrée.</p>
        ) : (
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(11rem,0.65fr)_minmax(0,1.35fr)] lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)] lg:grid-rows-1">
            <nav
              className="min-h-0 overflow-y-auto border-b border-stone-300 bg-[#f2eee5] p-3 lg:border-r lg:border-b-0"
              aria-label="Commandes récentes"
            >
              <div className="grid gap-2">
                {orders.map((order) => (
                  <OrderListItem
                    key={order.id}
                    order={order}
                    selected={order.id === selectedOrderId}
                    disabled={printing !== null}
                    onSelect={() => {
                      setSelectedOrderId(order.id)
                      setFeedback(null)
                    }}
                  />
                ))}
              </div>
            </nav>
            {selectedOrder ? (
              <OrderDetails
                order={selectedOrder}
                printing={printing}
                feedback={feedback}
                onReprint={(selection) => void reprint(selection)}
              />
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function OrderListItem({
  order,
  selected,
  disabled,
  onSelect,
}: {
  order: Order
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const { date, time } = formatTicketDateTime(order.createdAt)
  return (
    <button
      type="button"
      className={`min-h-24 rounded-[10px] border p-3 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${selected ? 'border-[#1f6a4b] bg-white outline-2 outline-[#1f6a4b]' : 'border-stone-300 bg-white active:bg-stone-100'}`}
      aria-pressed={selected}
      aria-label={`Commande ${order.orderNumber}, ${date} à ${time}, ${formatMoney(order.totalCents)}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-xl font-black">{order.orderNumber}</span>
        <span className="font-black tabular-nums">{formatMoney(order.totalCents)}</span>
      </span>
      <span className="mt-1 flex flex-wrap justify-between gap-x-3 text-sm font-bold text-stone-700">
        <span>
          {date} · {time}
        </span>
        <span>{paymentMethodLabels[order.paymentMethod]}</span>
      </span>
      <span className="mt-1 block text-sm font-black text-stone-800">
        Impression : {printStatusLabels[order.printing.status]}
      </span>
    </button>
  )
}

function OrderDetails({
  order,
  printing,
  feedback,
  onReprint,
}: {
  order: Order
  printing: PrintSelection | null
  feedback: Feedback | null
  onReprint: (selection: PrintSelection) => void
}) {
  const { date, time } = formatTicketDateTime(order.createdAt)
  return (
    <article className="min-h-0 overflow-y-auto p-4 sm:p-5" aria-labelledby="order-detail-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-300 pb-4">
        <div>
          <h3 id="order-detail-title" className="text-3xl font-black">
            Commande {order.orderNumber}
          </h3>
          <p className="mt-1 font-bold text-stone-700">
            {date} à {time} · {paymentMethodLabels[order.paymentMethod]}
          </p>
          <p className="text-sm font-bold text-stone-600">Reçu {order.receiptNumber}</p>
        </div>
        <div className="text-3xl font-black tabular-nums">{formatMoney(order.totalCents)}</div>
      </div>

      <section className="py-4" aria-label="Détail de la commande">
        <h4 className="text-lg font-black">{order.itemCount} article(s)</h4>
        <div className="mt-2 divide-y divide-stone-200 border-y border-stone-300">
          {order.items.map((item) => (
            <OrderLine key={item.lineId} item={item} />
          ))}
        </div>
      </section>

      <section className="border-t border-stone-300 pt-4" aria-label="État d’impression">
        <h4 className="text-lg font-black">
          Impression : {printStatusLabels[order.printing.status]}
        </h4>
        <div className="mt-2 text-sm font-bold text-stone-700" aria-live="polite">
          <p>Ticket client : {documentStatusLabels[order.printing.customerReceipt]}</p>
          <p>Ticket de préparation : {documentStatusLabels[order.printing.preparationTicket]}</p>
        </div>
        {order.printing.lastError ? (
          <p className="mt-2 text-sm font-bold text-rose-900">
            Dernier échec : {order.printing.lastError}
          </p>
        ) : null}

        <p className="mt-4 text-sm font-bold text-stone-600">
          La réimpression reprend les données et numéros de cette commande.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Button disabled={printing !== null} onClick={() => onReprint('customer')}>
            {printing === 'customer' ? 'Impression en cours…' : 'Ticket client'}
          </Button>
          <Button disabled={printing !== null} onClick={() => onReprint('preparation')}>
            {printing === 'preparation' ? 'Impression en cours…' : 'Préparation'}
          </Button>
          <Button variant="primary" disabled={printing !== null} onClick={() => onReprint('both')}>
            {printing === 'both' ? 'Impression en cours…' : 'Les deux tickets'}
          </Button>
        </div>
        {feedback ? <FeedbackBox feedback={feedback} /> : null}
      </section>
    </article>
  )
}

function OrderLine({ item }: { item: CartItem }) {
  const removedIngredients = getRemovedIngredients(item)
  return (
    <div className="flex gap-3 py-3">
      <span className="min-w-8 text-lg font-black tabular-nums">{item.quantity}×</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-black">
            {item.name}
            {item.variant
              ? ` · ${item.variant.name}${item.variant.volume ? ` ${item.variant.volume}` : ''}`
              : ''}
          </p>
          <p className="shrink-0 font-black tabular-nums">
            {formatMoney(item.unitPriceCents * item.quantity)}
          </p>
        </div>
        {item.options.map((option) => (
          <p
            key={`${option.groupId}:${option.optionId}`}
            className="text-sm font-bold text-stone-700"
          >
            {option.groupName} : {option.optionName}
          </p>
        ))}
        {removedIngredients.map((ingredient) => (
          <p key={ingredient.id} className="text-sm font-black text-rose-900">
            Sans {ingredient.name.toLocaleLowerCase('fr-FR')}
          </p>
        ))}
        {item.note ? <p className="text-sm font-bold text-stone-700">{item.note}</p> : null}
      </div>
    </div>
  )
}

function FeedbackBox({ feedback }: { feedback: Feedback }) {
  const colors =
    feedback.kind === 'error'
      ? 'border-rose-300 bg-rose-50 text-rose-950'
      : feedback.kind === 'warning'
        ? 'border-amber-300 bg-amber-50 text-amber-950'
        : 'border-emerald-300 bg-emerald-50 text-emerald-950'
  return (
    <div className={`mt-3 border p-3 font-bold ${colors}`} role="status">
      {feedback.text}
    </div>
  )
}
