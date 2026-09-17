import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  getCompletedDocumentsFromPrintError,
  getUnknownDocumentsFromPrintError,
  isProtectedCustomerReprint,
  printOrderTickets,
  type PrintOrderOptions,
} from '../../printing/orderPrintService'
import type { PrintJobResult, PrintSelection } from '../../printing/types'
import {
  createOrder as persistOrder,
  orderLifecycle as persistedOrderLifecycle,
} from '../../services/orderService'
import { checkoutService as persistedCheckoutService } from '../../services/checkoutService'
import type { CartItem } from '../../types/cart'
import type { CheckoutIntent } from '../../types/checkout'
import type { Order, PaymentMethod } from '../../types/order'
import { formatMoney } from '../../utils/money'

type Props = {
  items: CartItem[]
  onCancel: () => void
  onNewOrder: () => void
  printOrder?: (order: Order, options?: PrintOrderOptions) => Promise<PrintJobResult>
  createOrder?: typeof persistOrder
  checkout?: typeof persistedCheckoutService
  lifecycle?: typeof persistedOrderLifecycle
  initialOrder?: Order
  initialIntent?: CheckoutIntent
  onOrderUpdated?: (order: Order) => void
  onIntentUpdated?: (intent: CheckoutIntent) => void
  requestResponsibleAccess?: () => Promise<boolean>
}

type Feedback = { kind: 'success' | 'error' | 'warning'; text: string }

class PrintStatePersistenceError extends Error {
  constructor(public readonly printMayHaveStarted: boolean) {
    super('L’état de l’impression n’a pas pu être sauvegardé.')
  }
}

export function CheckoutFlow({
  items,
  onCancel,
  onNewOrder,
  printOrder = printOrderTickets,
  createOrder,
  checkout = persistedCheckoutService,
  lifecycle = persistedOrderLifecycle,
  initialOrder,
  initialIntent,
  onOrderUpdated,
  onIntentUpdated,
  requestResponsibleAccess = async () => true,
}: Props) {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(
    initialOrder?.paymentMethod ?? initialIntent?.paymentMethod ?? null,
  )
  const [cashReceivedCents, setCashReceivedCents] = useState<number | null>(null)
  const [printCustomerReceipt, setPrintCustomerReceipt] = useState(
    initialOrder?.printing.customerReceipt !== 'not_requested',
  )
  const [order, setOrder] = useState<Order | null>(initialOrder ?? null)
  const [intent, setIntent] = useState<CheckoutIntent | null>(initialIntent ?? null)
  const [printingComplete, setPrintingComplete] = useState(
    initialOrder?.printing.status === 'printed',
  )
  const [manualReprintMode, setManualReprintMode] = useState(false)
  const [deferConfirmationOpen, setDeferConfirmationOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const printingRef = useRef(false)
  const authorizingRef = useRef(false)
  const deferringRef = useRef(false)
  const displayedItems = order?.items ?? intent?.cartSnapshot ?? items
  const totalCents = displayedItems.reduce(
    (total, item) => total + item.unitPriceCents * item.quantity,
    0,
  )
  const hasSufficientCash = cashReceivedCents !== null && cashReceivedCents >= totalCents

  const storeUpdatedOrder = (updatedOrder: Order) => {
    setOrder(updatedOrder)
    onOrderUpdated?.(updatedOrder)
    return updatedOrder
  }

  const storeUpdatedIntent = (updatedIntent: CheckoutIntent) => {
    setIntent(updatedIntent)
    onIntentUpdated?.(updatedIntent)
    return updatedIntent
  }

  const performPrint = async (
    targetOrder: Order,
    options: PrintOrderOptions,
    trackLifecycle: boolean,
  ) => {
    const selection = options.selection ?? 'both'
    let printingOrder = targetOrder
    if (trackLifecycle) {
      try {
        printingOrder = storeUpdatedOrder(await lifecycle.beginPrinting(targetOrder.id, selection))
      } catch {
        throw new PrintStatePersistenceError(false)
      }
    }

    let result: PrintJobResult
    try {
      result = await printOrder(targetOrder, options)
    } catch (error) {
      if (trackLifecycle) {
        const message =
          error instanceof Error ? error.message : 'L’impression a échoué sans détail.'
        try {
          const failedOrder = storeUpdatedOrder(
            await lifecycle.failPrinting(
              targetOrder.id,
              selection,
              getCompletedDocumentsFromPrintError(error, options),
              message,
              getUnknownDocumentsFromPrintError(error),
            ),
          )
          if (failedOrder.printing.status === 'printed') {
            setPrintingComplete(true)
            setManualReprintMode(false)
            setFeedback({
              kind: 'warning',
              text: `Tickets imprimés, mais la coupe a échoué. Détachez-les manuellement. ${message}`,
            })
            return
          }
        } catch {
          throw new PrintStatePersistenceError(true)
        }
      }
      throw error
    }

    let updatedOrder = printingOrder
    if (trackLifecycle) {
      try {
        updatedOrder = storeUpdatedOrder(
          await lifecycle.completePrinting(targetOrder.id, selection, result.completedDocuments),
        )
      } catch {
        throw new PrintStatePersistenceError(true)
      }
    }
    setPrintingComplete(!trackLifecycle || updatedOrder.printing.status === 'printed')
    if (!trackLifecycle || updatedOrder.printing.status === 'printed') {
      setManualReprintMode(false)
    }
    if (trackLifecycle && updatedOrder.printing.status !== 'printed') {
      setFeedback({
        kind: 'warning',
        text: 'Certains tickets restent à imprimer ou à vérifier. Consultez leur état avant de poursuivre.',
      })
      return
    }
    setFeedback(
      result.warnings.length
        ? { kind: 'warning', text: `Impression terminée. ${result.warnings.join(' ')}` }
        : {
            kind: 'success',
            text: 'Impression terminée : tous les tickets demandés ont été envoyés.',
          },
    )
  }

  const reportPrintFailure = (targetOrder: Order, error: unknown) => {
    const details =
      error instanceof Error
        ? error.message
        : 'L’impression a échoué. Vérifiez l’imprimante puis réessayez.'
    setFeedback({
      kind: 'error',
      text: `Commande ${targetOrder.orderNumber} enregistrée. ${details}`,
    })
  }

  const runPrint = async (
    targetOrder: Order,
    options: PrintOrderOptions,
    trackLifecycle = true,
  ) => {
    if (printingRef.current) return
    printingRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await performPrint(targetOrder, options, trackLifecycle)
    } catch (error) {
      if (error instanceof PrintStatePersistenceError) {
        setFeedback({
          kind: 'error',
          text: error.printMayHaveStarted
            ? `Commande ${targetOrder.orderNumber} enregistrée. L’état final de l’impression n’a pas pu être sauvegardé. Vérifiez les tickets sortis avant de relancer.`
            : `Commande ${targetOrder.orderNumber} enregistrée. Aucun ticket n’a été lancé car l’état de reprise n’a pas pu être sauvegardé.`,
        })
        return
      }
      reportPrintFailure(targetOrder, error)
    } finally {
      printingRef.current = false
      setBusy(false)
    }
  }

  const checkoutAndPrint = () => {
    if (order) {
      if (order.printing.status === 'unknown') {
        setManualReprintMode(true)
        setFeedback({
          kind: 'warning',
          text: 'L’état de certains tickets est incertain. Vérifiez les tickets déjà sortis puis choisissez explicitement celui à réimprimer.',
        })
        return
      }
      const selection = getPendingSelection(order)
      if (!selection) {
        if (order.printing.status === 'printed') setPrintingComplete(true)
        else setManualReprintMode(true)
        return
      }
      void runPrint(order, { printCustomerReceipt, selection })
      return
    }
    if (printingRef.current) return
    if (!paymentMethod) return

    printingRef.current = true
    setBusy(true)
    setFeedback(null)
    void (async () => {
      try {
        if (!createOrder) {
          try {
            let activeIntent = intent
            if (!activeIntent) {
              activeIntent = storeUpdatedIntent(
                await checkout.createIntent(items, paymentMethod, printCustomerReceipt),
              )
            }
            if (activeIntent.status === 'pending_payment') {
              activeIntent = storeUpdatedIntent(await checkout.beginPayment(activeIntent.id))
              setFeedback({
                kind: 'warning',
                text:
                  activeIntent.paymentMethod === 'card'
                    ? `Effectuez maintenant le paiement de ${formatMoney(activeIntent.totalCents)} sur le TPE, puis confirmez son résultat.`
                    : `Encaissez ${formatMoney(activeIntent.totalCents)}, rendez la monnaie indiquée, puis confirmez que les espèces ont été reçues.`,
              })
              return
            }
            if (activeIntent.status === 'payment_to_verify') {
              activeIntent = storeUpdatedIntent(await checkout.confirmPayment(activeIntent.id))
            }
            if (activeIntent.status !== 'payment_confirmed') return

            let persistedOrder: Order
            try {
              persistedOrder = await checkout.finalize(activeIntent.id)
            } catch {
              setFeedback({
                kind: 'error',
                text: 'Le paiement est marqué comme effectué, mais la vente n’a pas pu être finalisée. Ne faites pas payer le client une deuxième fois. Réessayez la finalisation.',
              })
              return
            }
            storeUpdatedIntent({
              ...activeIntent,
              status: 'finalized',
              finalizedOrderId: persistedOrder.id,
              updatedAt: new Date().toISOString(),
            })
            storeUpdatedOrder(persistedOrder)
            try {
              await performPrint(persistedOrder, { printCustomerReceipt }, true)
            } catch (error) {
              if (error instanceof PrintStatePersistenceError) {
                setFeedback({
                  kind: 'error',
                  text: error.printMayHaveStarted
                    ? `Commande ${persistedOrder.orderNumber} enregistrée. L’état final de l’impression n’a pas pu être sauvegardé. Vérifiez les tickets sortis avant de relancer.`
                    : `Commande ${persistedOrder.orderNumber} enregistrée. Aucun ticket n’a été lancé car l’état de reprise n’a pas pu être sauvegardé.`,
                })
              } else {
                reportPrintFailure(persistedOrder, error)
              }
            }
            return
          } catch {
            if (!intent) {
              setFeedback({
                kind: 'error',
                text: 'Impossible de préparer l’encaissement. Aucun paiement ne doit être effectué.',
              })
            } else {
              setFeedback({
                kind: 'error',
                text: 'L’encaissement reste enregistré sur cette tablette. Vérifiez son état avant de continuer.',
              })
            }
            return
          }
        }

        let persistedOrder: Order
        try {
          persistedOrder = await createOrder(items, paymentMethod, new Date(), printCustomerReceipt)
        } catch {
          setFeedback({
            kind: 'error',
            text: 'La commande n’a pas été enregistrée. Aucun ticket n’a été imprimé. Réessayez.',
          })
          return
        }

        storeUpdatedOrder(persistedOrder)
        try {
          await performPrint(persistedOrder, { printCustomerReceipt }, true)
        } catch (error) {
          if (error instanceof PrintStatePersistenceError) {
            setFeedback({
              kind: 'error',
              text: error.printMayHaveStarted
                ? `Commande ${persistedOrder.orderNumber} enregistrée. L’état final de l’impression n’a pas pu être sauvegardé. Vérifiez les tickets sortis avant de relancer.`
                : `Commande ${persistedOrder.orderNumber} enregistrée. Aucun ticket n’a été lancé car l’état de reprise n’a pas pu être sauvegardé.`,
            })
          } else {
            reportPrintFailure(persistedOrder, error)
          }
        }
      } finally {
        printingRef.current = false
        setBusy(false)
      }
    })()
  }

  const abandonPayment = () => {
    if (!intent || intent.status === 'payment_confirmed' || busy || printingRef.current) return
    printingRef.current = true
    setBusy(true)
    setFeedback(null)
    void checkout
      .abandon(intent.id)
      .then((abandoned) => {
        storeUpdatedIntent(abandoned)
        onNewOrder()
      })
      .catch(() => {
        setFeedback({
          kind: 'error',
          text: 'Impossible d’enregistrer l’annulation. L’encaissement reste à vérifier.',
        })
      })
      .finally(() => {
        printingRef.current = false
        setBusy(false)
      })
  }

  const reprint = async (selection: PrintSelection) => {
    if (!order) return
    const options = { selection, printCustomerReceipt: true, reprint: true } as const
    if (isProtectedCustomerReprint(order, options)) {
      if (authorizingRef.current) return
      authorizingRef.current = true
      try {
        if (!(await requestResponsibleAccess())) return
      } finally {
        authorizingRef.current = false
      }
    }
    await runPrint(order, options, order.printing.status !== 'printed')
  }

  const continueWithNextOrder = () => {
    if (busy || deferringRef.current || !order || order.printing.status === 'printed') return
    deferringRef.current = true
    setDeferConfirmationOpen(false)
    onNewOrder()
  }

  const deferPrintingAndStartNewOrder = () => {
    if (busy || deferringRef.current || !order || order.printing.status === 'printed') return
    if (order.printing.preparationTicket !== 'printed') {
      setDeferConfirmationOpen(true)
      return
    }
    continueWithNextOrder()
  }

  const canDeferPrinting = order !== null && order.printing.status !== 'printed'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-title"
      onClick={() => {
        if (!busy && order === null && intent === null) onCancel()
      }}
    >
      <section
        className="my-auto w-full max-w-2xl rounded-[12px] border border-stone-300 bg-[#fffdf8] p-5 sm:p-7"
        onClick={(event) => event.stopPropagation()}
      >
        {!printingComplete && !manualReprintMode ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="checkout-title" className="text-3xl font-black">
                  Encaissement
                </h2>
                <p className="mt-1 font-bold text-stone-600">
                  {displayedItems.reduce((count, item) => count + item.quantity, 0)} article(s)
                </p>
              </div>
              <div className="text-4xl font-black tabular-nums">{formatMoney(totalCents)}</div>
            </div>

            <fieldset className="mt-6" aria-describedby="payment-method-status">
              <legend className="text-lg font-black">Mode de paiement</legend>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Button
                  className={`min-h-20 text-xl ${paymentMethod === 'card' ? 'outline-3 outline-offset-2 outline-[#1f6a4b]' : ''}`}
                  variant={paymentMethod === 'card' ? 'primary' : 'secondary'}
                  disabled={busy || order !== null || intent !== null}
                  aria-pressed={paymentMethod === 'card'}
                  onClick={() => setPaymentMethod('card')}
                >
                  Carte bancaire
                </Button>
                <Button
                  className={`min-h-20 text-xl ${paymentMethod === 'cash' ? 'outline-3 outline-offset-2 outline-[#1f6a4b]' : ''}`}
                  variant={paymentMethod === 'cash' ? 'primary' : 'secondary'}
                  disabled={busy || order !== null || intent !== null}
                  aria-pressed={paymentMethod === 'cash'}
                  onClick={() => setPaymentMethod('cash')}
                >
                  Espèces
                </Button>
              </div>
              <p
                id="payment-method-status"
                className="mt-3 text-sm font-bold text-stone-700"
                aria-live="polite"
              >
                {paymentMethod
                  ? `Paiement sélectionné : ${paymentMethod === 'card' ? 'Carte bancaire' : 'Espèces'}`
                  : 'Sélectionnez Carte bancaire ou Espèces pour continuer.'}
              </p>
            </fieldset>

            {paymentMethod === 'cash' && order === null && intent === null ? (
              <CashPayment
                totalCents={totalCents}
                receivedCents={cashReceivedCents}
                disabled={busy}
                onAppendDigit={(digit) => {
                  setCashReceivedCents((current) => (current ?? 0) * 10 + digit)
                }}
                onAppendDoubleZero={() => {
                  setCashReceivedCents((current) => (current ?? 0) * 100)
                }}
                onDeleteLastDigit={() => {
                  setCashReceivedCents((current) => {
                    if (current === null || current < 10) return null
                    return Math.floor(current / 10)
                  })
                }}
                onSetExactAmount={() => setCashReceivedCents(totalCents)}
              />
            ) : null}

            <label className="mt-5 flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-stone-300 bg-white px-4 font-bold">
              <input
                type="checkbox"
                className="size-6 accent-[#1f6a4b]"
                checked={printCustomerReceipt}
                disabled={busy || order !== null || intent !== null}
                onChange={(event) => setPrintCustomerReceipt(event.target.checked)}
              />
              Imprimer le ticket client
              <span className="ml-auto text-xs text-stone-500">
                Le ticket préparation est toujours imprimé
              </span>
            </label>

            {order ? (
              <div className="mt-4 font-bold text-[#1f6a4b]">
                <p className="font-black">
                  Commande {order.orderNumber} · reçu {order.receiptNumber}
                </p>
                <p className="mt-1 text-sm">Paiement enregistré · {printStatusLabel(order)}</p>
                <DocumentStatuses order={order} />
                <PreparationWarning order={order} />
              </div>
            ) : null}

            {intent && !order ? (
              <div
                className="mt-5 border-2 border-amber-500 bg-amber-50 p-4 text-amber-950"
                role="status"
              >
                <p className="text-lg font-black">
                  {intent.status === 'pending_payment'
                    ? 'Paiement prêt à démarrer'
                    : intent.status === 'payment_confirmed'
                      ? 'Paiement confirmé — vente à finaliser'
                      : 'Paiement à vérifier'}
                </p>
                <p className="mt-1 font-bold">
                  {intent.status === 'pending_payment'
                    ? 'Aucun paiement ne doit être effectué avant d’appuyer sur le bouton ci-dessous.'
                    : intent.status === 'payment_confirmed'
                      ? 'Ne faites pas payer le client une deuxième fois. Réessayez uniquement l’enregistrement de la vente.'
                      : intent.paymentMethod === 'card'
                        ? 'Vérifiez le TPE. Samhain ne peut pas connaître automatiquement le résultat.'
                        : 'Vérifiez que les espèces ont bien été reçues et la monnaie rendue.'}
                </p>
              </div>
            ) : null}

            {feedback ? <FeedbackBox feedback={feedback} /> : null}

            <div className="mt-6 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              {intent && !order && intent.status !== 'payment_confirmed' ? (
                <Button disabled={busy} onClick={abandonPayment}>
                  Paiement non effectué / annulé
                </Button>
              ) : (
                <Button disabled={busy || order !== null || intent !== null} onClick={onCancel}>
                  Retour
                </Button>
              )}
              <Button
                variant="primary"
                className="min-h-16 text-xl"
                disabled={
                  busy ||
                  (order === null &&
                    intent === null &&
                    (paymentMethod === null || (paymentMethod === 'cash' && !hasSufficientCash)))
                }
                onClick={checkoutAndPrint}
              >
                {busy
                  ? createOrder
                    ? 'Impression en cours…'
                    : 'Traitement en cours…'
                  : order
                    ? order.printing.status === 'unknown'
                      ? 'Vérifier les tickets'
                      : initialOrder
                        ? 'Reprendre l’impression'
                        : 'Réessayer l’impression'
                    : intent?.status === 'pending_payment'
                      ? 'Commencer le paiement'
                      : intent?.status === 'payment_to_verify'
                        ? intent.paymentMethod === 'card'
                          ? 'Paiement TPE accepté'
                          : 'Espèces reçues'
                        : intent?.status === 'payment_confirmed'
                          ? 'Finaliser la vente'
                          : paymentMethod === 'card'
                            ? createOrder
                              ? 'Encaisser et imprimer'
                              : 'Préparer le paiement TPE'
                            : createOrder
                              ? 'Encaisser et imprimer'
                              : 'Préparer l’encaissement'}
              </Button>
            </div>
            {canDeferPrinting ? (
              <Button
                fullWidth
                className="mt-3 min-h-14"
                disabled={busy}
                onClick={deferPrintingAndStartNewOrder}
              >
                Mettre en attente et nouvelle commande
              </Button>
            ) : null}
          </>
        ) : manualReprintMode && !printingComplete ? (
          <div className="text-center">
            <h2 id="checkout-title" className="text-3xl font-black">
              Vérifier les tickets
            </h2>
            <p className="mt-3 text-lg font-black text-[#1f6a4b]">
              Commande {order?.orderNumber} · reçu {order?.receiptNumber}
            </p>
            <p className="mt-1 font-bold text-stone-700">
              Paiement enregistré · aucune nouvelle vente à créer
            </p>
            {feedback ? <FeedbackBox feedback={feedback} /> : null}

            <div className="mt-5 border-t border-stone-300 pt-5 text-left">
              {order ? (
                <>
                  <DocumentStatuses order={order} />
                  <PreparationWarning order={order} />
                </>
              ) : null}
              <p className="mt-4 mb-3 text-sm font-black text-stone-600">
                Choisissez uniquement un ticket dont la sortie a été vérifiée.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button disabled={busy} onClick={() => void reprint('both')}>
                  Les deux
                </Button>
                <Button disabled={busy} onClick={() => void reprint('customer')}>
                  Ticket client
                </Button>
                <Button disabled={busy} onClick={() => void reprint('preparation')}>
                  Préparation
                </Button>
              </div>
            </div>

            <Button
              fullWidth
              className="mt-6 min-h-14"
              disabled={busy}
              onClick={deferPrintingAndStartNewOrder}
            >
              Mettre en attente et nouvelle commande
            </Button>
          </div>
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
              {order ? <DocumentStatuses order={order} /> : null}
              <p className="mb-3 text-sm font-black text-stone-600">
                Réimpression — conserve les mêmes numéros
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button disabled={busy} onClick={() => void reprint('both')}>
                  Les deux
                </Button>
                <Button disabled={busy} onClick={() => void reprint('customer')}>
                  Ticket client
                </Button>
                <Button disabled={busy} onClick={() => void reprint('preparation')}>
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

      {deferConfirmationOpen && order ? (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-stone-950/70 p-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="defer-printing-title"
          onClick={() => setDeferConfirmationOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-[12px] border border-amber-300 bg-[#fffdf8] p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="defer-printing-title" className="text-2xl font-black">
              Mettre l’impression en attente ?
            </h2>
            <p className="mt-3 font-bold text-stone-800">
              La commande {order.orderNumber} est payée et enregistrée, mais le ticket de
              préparation n’est pas terminé. Elle restera dans les impressions à reprendre.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Button disabled={busy} onClick={() => setDeferConfirmationOpen(false)}>
                Continuer l’impression
              </Button>
              <Button variant="primary" disabled={busy} onClick={continueWithNextOrder}>
                Mettre en attente
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type CashPaymentProps = {
  totalCents: number
  receivedCents: number | null
  disabled: boolean
  onAppendDigit: (digit: number) => void
  onAppendDoubleZero: () => void
  onDeleteLastDigit: () => void
  onSetExactAmount: () => void
}

function CashPayment({
  totalCents,
  receivedCents,
  disabled,
  onAppendDigit,
  onAppendDoubleZero,
  onDeleteLastDigit,
  onSetExactAmount,
}: CashPaymentProps) {
  const isSufficient = receivedCents !== null && receivedCents >= totalCents
  const changeCents = isSufficient && receivedCents !== null ? receivedCents - totalCents : null
  const missingCents = receivedCents === null ? null : Math.max(totalCents - receivedCents, 0)

  return (
    <section className="mt-5 border-t border-stone-300 pt-5" aria-labelledby="cash-payment-title">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id="cash-payment-title" className="text-lg font-black">
          Paiement en espèces
        </h3>
        <Button className="min-h-12 px-4" disabled={disabled} onClick={onSetExactAmount}>
          Montant exact — {formatMoney(totalCents)}
        </Button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[10px] border border-stone-300 bg-white p-4">
          <p className="text-sm font-bold text-stone-700">Montant reçu</p>
          <output className="mt-1 block text-3xl font-black tabular-nums" aria-live="polite">
            {receivedCents === null ? '—' : formatMoney(receivedCents)}
          </output>
        </div>
        <div
          className={`rounded-[10px] border p-4 ${
            isSufficient
              ? 'border-[#1f6a4b] bg-emerald-50 text-emerald-950'
              : 'border-stone-300 bg-stone-100 text-stone-800'
          }`}
          aria-live="polite"
        >
          <p className="text-sm font-bold">Monnaie à rendre</p>
          <p className="mt-1 text-3xl font-black tabular-nums">
            {changeCents === null ? '—' : formatMoney(changeCents)}
          </p>
          {!isSufficient ? (
            <p className="mt-1 text-sm font-bold">
              {missingCents === null
                ? 'Saisissez le montant reçu.'
                : `Il manque ${formatMoney(missingCents)}.`}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Pavé numérique du montant reçu">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
          <Button
            key={digit}
            className="min-h-16 text-2xl"
            disabled={disabled}
            onClick={() => onAppendDigit(digit)}
          >
            {digit}
          </Button>
        ))}
        <Button className="min-h-16 text-xl" disabled={disabled} onClick={() => onAppendDigit(0)}>
          0
        </Button>
        <Button className="min-h-16 text-xl" disabled={disabled} onClick={onAppendDoubleZero}>
          00
        </Button>
        <Button
          className="min-h-16 px-3 text-sm"
          disabled={disabled || receivedCents === null}
          onClick={onDeleteLastDigit}
        >
          Effacer le dernier chiffre
        </Button>
      </div>
    </section>
  )
}

function getPendingSelection(order: Order): PrintSelection | null {
  const needsCustomer = ['pending', 'failed'].includes(order.printing.customerReceipt)
  const needsPreparation = ['pending', 'failed'].includes(order.printing.preparationTicket)
  if (needsCustomer && needsPreparation) return 'both'
  if (needsCustomer) return 'customer'
  if (needsPreparation) return 'preparation'
  return null
}

function printStatusLabel(order: Order): string {
  if (order.printing.status === 'partial') return 'impression partielle à reprendre'
  if (order.printing.status === 'failed') return 'impression échouée à reprendre'
  if (order.printing.status === 'unknown') return 'état d’impression à vérifier'
  if (order.printing.status === 'printed') return 'impression terminée'
  return 'impression en attente'
}

function DocumentStatuses({ order }: { order: Order }) {
  const labels = {
    not_requested: 'non demandé',
    pending: 'à imprimer',
    printed: 'imprimé',
    failed: 'échec — à reprendre',
    unknown: 'à vérifier avant réimpression',
  }
  return (
    <div className="mt-2 text-sm text-stone-800" aria-live="polite">
      <p>Ticket client : {labels[order.printing.customerReceipt]}</p>
      <p>Ticket de préparation : {labels[order.printing.preparationTicket]}</p>
    </div>
  )
}

function PreparationWarning({ order }: { order: Order }) {
  if (order.printing.preparationTicket === 'printed') return null
  return (
    <div
      className="mt-4 border-2 border-amber-500 bg-amber-100 p-3 font-black text-amber-950"
      role="alert"
    >
      Attention : le ticket de préparation n’a pas été imprimé. La cuisine peut ne pas avoir reçu
      cette commande.
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
