import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  deriveSaleCorrectionSummary,
  saleCorrectionStatusLabels,
} from '../../services/saleCorrectionSummary'
import type { SalesLedgerService } from '../../services/salesLedgerService'
import type { Order } from '../../types/order'
import type { CorrectionLedgerEntry } from '../../types/salesLedger'
import { formatMoney } from '../../utils/money'
import { buildRefundLines, refundLinesTotalCents } from '../../services/saleRefund'

export type CorrectionAction = 'cancellation' | 'refund'

type Props = {
  order: Order
  corrections: CorrectionLedgerEntry[]
  ledgerService: Pick<SalesLedgerService, 'cancelSale' | 'refundSale'>
  createOperationId: () => string
  requestResponsibleAccess: () => Promise<boolean>
  onClose: () => void
  onRecorded: (type: CorrectionAction) => Promise<void>
}

export function SaleCorrectionDialog({
  order,
  corrections,
  ledgerService,
  createOperationId,
  requestResponsibleAccess,
  onClose,
  onRecorded,
}: Props) {
  const summary = deriveSaleCorrectionSummary(order, corrections)
  const [action, setAction] = useState<CorrectionAction | null>(null)
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationId] = useState(createOperationId)
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({})
  const submittingRef = useRef(false)
  const trimmedReason = reason.trim()
  const selections = summary.refundableLines
    .map((line) => ({
      originalLineId: line.originalLineId,
      quantity: refundQuantities[line.originalLineId] ?? 0,
    }))
    .filter((selection) => selection.quantity > 0)
  const refundLines = selections.length ? buildRefundLines(order, selections, corrections) : []
  const amountCents =
    action === 'cancellation' ? order.totalCents : refundLinesTotalCents(refundLines)
  const vatByRate = new Map<number, number>()
  for (const line of refundLines) {
    vatByRate.set(line.vatRate, (vatByRate.get(line.vatRate) ?? 0) + line.vatCents)
  }

  const submit = async () => {
    if (!action || !trimmedReason || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      if (action === 'cancellation') {
        await ledgerService.cancelSale(order.id, trimmedReason, operationId)
      } else {
        await ledgerService.refundSale(order.id, selections, trimmedReason, operationId)
      }
      await onRecorded(action)
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'La correction n’a pas été enregistrée. La vente originale reste inchangée.',
      )
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-950/75 p-3 sm:p-5"
      role={confirming ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby="sale-correction-title"
      onClick={(event) => {
        event.stopPropagation()
        if (!submitting) onClose()
      }}
    >
      <section
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-y-auto border border-stone-300 bg-[#fffdf8] p-5 sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="sale-correction-title" className="text-2xl font-black">
          {confirming
            ? action === 'cancellation'
              ? 'Confirmer l’annulation ?'
              : 'Confirmer le remboursement ?'
            : 'Corriger la vente'}
        </h3>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-stone-300 py-4">
          <div>
            <dt className="text-sm font-bold text-stone-600">Commande</dt>
            <dd className="font-black">{order.orderNumber}</dd>
          </div>
          <div>
            <dt className="text-sm font-bold text-stone-600">Total original</dt>
            <dd className="font-black tabular-nums">{formatMoney(order.totalCents)}</dd>
          </div>
          <div>
            <dt className="text-sm font-bold text-stone-600">Statut</dt>
            <dd className="font-black">{saleCorrectionStatusLabels[summary.status]}</dd>
          </div>
          <div>
            <dt className="text-sm font-bold text-stone-600">Restant remboursable</dt>
            <dd className="font-black tabular-nums">
              {formatMoney(summary.remainingRefundableCents)}
            </dd>
          </div>
        </dl>

        {confirming && action ? (
          <>
            <dl className="mt-5 grid gap-3">
              <div>
                <dt className="font-bold text-stone-600">Opération</dt>
                <dd className="text-lg font-black">
                  {action === 'cancellation' ? 'Annulation totale' : 'Remboursement par articles'}
                </dd>
              </div>
              {action === 'refund' ? (
                <div>
                  <dt className="font-bold text-stone-600">Articles remboursés</dt>
                  <dd className="mt-2 divide-y divide-stone-200 border-y border-stone-300">
                    {refundLines.map((line) => (
                      <span
                        className="flex justify-between gap-3 py-2 font-black"
                        key={line.originalLineId}
                      >
                        <span>
                          {line.quantity} × {line.productName}
                        </span>
                        <span className="tabular-nums">{formatMoney(line.grossCents)}</span>
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-bold text-stone-600">Montant</dt>
                <dd className="text-lg font-black tabular-nums">{formatMoney(amountCents)}</dd>
              </div>
              {action === 'refund' ? (
                <div>
                  <dt className="font-bold text-stone-600">TVA incluse</dt>
                  <dd className="font-black">
                    {[...vatByRate.entries()]
                      .sort(([left], [right]) => left - right)
                      .map(([rate, vatCents]) => `TVA ${rate} % : ${formatMoney(vatCents)}`)
                      .join(' · ')}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-bold text-stone-600">Motif</dt>
                <dd className="font-black">{trimmedReason}</dd>
              </div>
            </dl>
            <p className="mt-4 border-l-4 border-amber-500 bg-amber-50 p-3 font-bold text-amber-950">
              Cette opération crée une correction dans le journal. La vente originale restera
              conservée. Aucun justificatif ne sera imprimé automatiquement.
            </p>
          </>
        ) : (
          <>
            <fieldset className="mt-5">
              <legend className="font-black">Type de correction</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Button
                  className="min-h-16"
                  variant={action === 'cancellation' ? 'danger' : 'secondary'}
                  aria-pressed={action === 'cancellation'}
                  disabled={!summary.canCancel}
                  onClick={() => {
                    setAction('cancellation')
                    setError(null)
                  }}
                >
                  Annulation totale
                </Button>
                <Button
                  className="min-h-16"
                  variant={action === 'refund' ? 'primary' : 'secondary'}
                  aria-pressed={action === 'refund'}
                  disabled={!summary.canRefund}
                  onClick={() => {
                    setAction('refund')
                    setError(null)
                  }}
                >
                  Remboursement
                </Button>
              </div>
            </fieldset>
            {action === 'refund' ? (
              <fieldset className="mt-5">
                <legend className="font-black">Articles et quantités à rembourser</legend>
                <div className="mt-2 divide-y divide-stone-300 border-y border-stone-300">
                  {summary.refundableLines.map((line) => {
                    const quantity = refundQuantities[line.originalLineId] ?? 0
                    return (
                      <div className="py-3" key={line.originalLineId}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-black">{line.productName}</p>
                            <p className="text-sm font-bold text-stone-700">
                              Vendue {line.soldQuantity} · déjà remboursée {line.refundedQuantity} ·
                              encore remboursable {line.remainingQuantity}
                            </p>
                          </div>
                          <p className="shrink-0 font-black tabular-nums">
                            {formatMoney(line.unitPriceCents * quantity)}
                          </p>
                        </div>
                        <div
                          className="mt-2 flex items-center gap-3"
                          aria-label={`Quantité à rembourser pour ${line.productName}`}
                        >
                          <Button
                            className="min-h-12 min-w-14 text-xl"
                            disabled={quantity === 0 || submitting}
                            aria-label={`Diminuer ${line.productName}`}
                            onClick={() =>
                              setRefundQuantities((current) => ({
                                ...current,
                                [line.originalLineId]: Math.max(0, quantity - 1),
                              }))
                            }
                          >
                            −
                          </Button>
                          <output
                            className="min-w-10 text-center text-xl font-black tabular-nums"
                            aria-live="polite"
                          >
                            {quantity}
                          </output>
                          <Button
                            className="min-h-12 min-w-14 text-xl"
                            disabled={
                              quantity >= line.remainingQuantity ||
                              line.remainingQuantity === 0 ||
                              submitting
                            }
                            aria-label={`Augmenter ${line.productName}`}
                            onClick={() =>
                              setRefundQuantities((current) => ({
                                ...current,
                                [line.originalLineId]: Math.min(
                                  line.remainingQuantity,
                                  quantity + 1,
                                ),
                              }))
                            }
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="mt-3 text-lg font-black tabular-nums">
                  Montant remboursé : {formatMoney(amountCents)}
                </p>
              </fieldset>
            ) : null}
            {summary.hasLegacyAmountOnlyRefund ? (
              <p className="mt-4 border border-amber-400 bg-amber-50 p-3 font-bold text-amber-950">
                Un ancien remboursement ne précise pas les articles concernés. Les quantités
                restantes ne peuvent pas être déterminées sans les inventer.
              </p>
            ) : null}
            <label className="mt-5 block font-black" htmlFor="sale-correction-reason">
              Motif obligatoire
            </label>
            <textarea
              id="sale-correction-reason"
              className="mt-2 min-h-24 w-full rounded-[8px] border border-stone-400 bg-white p-3 font-bold"
              value={reason}
              disabled={submitting}
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value)
                setError(null)
              }}
            />
            {reason.length > 0 && !trimmedReason ? (
              <p className="mt-2 font-bold text-rose-900" role="alert">
                Un motif explicite est obligatoire.
              </p>
            ) : null}
          </>
        )}

        {error ? (
          <div
            className="mt-4 border border-rose-300 bg-rose-50 p-3 font-bold text-rose-950"
            role="alert"
          >
            <p>{error}</p>
            {error.toLocaleLowerCase('fr-FR').includes('responsable') ? (
              <Button
                className="mt-3"
                disabled={submitting}
                onClick={() =>
                  void requestResponsibleAccess().then((authorized) => authorized && setError(null))
                }
              >
                Déverrouiller le mode responsable
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button
            disabled={submitting}
            onClick={() => {
              if (confirming) {
                setConfirming(false)
                setError(null)
              } else onClose()
            }}
          >
            Retour
          </Button>
          {confirming ? (
            <Button variant="danger" disabled={submitting} onClick={() => void submit()}>
              {submitting
                ? action === 'cancellation'
                  ? 'Annulation…'
                  : 'Remboursement…'
                : action === 'cancellation'
                  ? 'Annuler la vente'
                  : 'Rembourser la vente'}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={
                !action ||
                !trimmedReason ||
                submitting ||
                (action === 'refund' && refundLines.length === 0)
              }
              onClick={() => setConfirming(true)}
            >
              Vérifier la correction
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}
