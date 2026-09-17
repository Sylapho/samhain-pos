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
  const submittingRef = useRef(false)
  const trimmedReason = reason.trim()
  const amountCents =
    action === 'cancellation' ? order.totalCents : summary.remainingRefundableCents

  const submit = async () => {
    if (!action || !trimmedReason || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      if (action === 'cancellation') {
        await ledgerService.cancelSale(order.id, trimmedReason, operationId)
      } else {
        await ledgerService.refundSale(
          order.id,
          summary.remainingRefundableCents,
          trimmedReason,
          operationId,
        )
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
                  {action === 'cancellation' ? 'Annulation totale' : 'Remboursement total'}
                </dd>
              </div>
              <div>
                <dt className="font-bold text-stone-600">Montant</dt>
                <dd className="text-lg font-black tabular-nums">{formatMoney(amountCents)}</dd>
              </div>
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
                  Remboursement total
                </Button>
              </div>
            </fieldset>
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
              disabled={!action || !trimmedReason || submitting}
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
