import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { CashSession } from '../../types/salesLedger'
import { formatMoney } from '../../utils/money'
import { appendCashDigits, deleteLastCashDigit } from '../checkout/cashPayment'

type Props = {
  mode: 'opening' | 'editing'
  currentAmountCents?: number
  onSubmit: (amountCents: number) => Promise<CashSession>
  onCancel?: () => void
  onManageTerminal?: () => void
}

export function CashFloatDialog({
  mode,
  currentAmountCents,
  onSubmit,
  onCancel,
  onManageTerminal,
}: Props) {
  const [amountCents, setAmountCents] = useState<number | null>(
    mode === 'editing' ? (currentAmountCents ?? null) : null,
  )
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const title = mode === 'opening' ? 'Fond de caisse' : 'Modifier le fond de caisse'

  const save = async () => {
    if (amountCents === null || savingRef.current) return
    savingRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(amountCents)
    } catch {
      setConfirming(false)
      setError(
        mode === 'opening'
          ? 'Le fond de caisse n’a pas pu être enregistré. Aucun encaissement n’est possible. Réessayez.'
          : 'Le fond de caisse n’a pas pu être modifié. La valeur précédente est conservée.',
      )
    } finally {
      savingRef.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cash-float-title"
    >
      <section className="my-auto w-full max-w-lg border border-stone-300 bg-[#fffdf8] p-5 sm:p-7">
        <h2 id="cash-float-title" className="text-3xl font-black">
          {title}
        </h2>
        <p className="mt-2 font-semibold text-stone-700">
          {mode === 'opening'
            ? 'Indiquez le montant d’espèces présent dans la caisse avant le début du service.'
            : 'Saisissez le montant réellement présent avant les premières ventes de cette session.'}
        </p>

        {mode === 'editing' && currentAmountCents !== undefined ? (
          <p className="mt-4 border-l-4 border-stone-400 pl-3 font-bold text-stone-700">
            Montant actuel : {formatMoney(currentAmountCents)}
          </p>
        ) : null}

        <output
          className="mt-5 block border-y border-stone-300 py-4 text-center text-5xl font-black tabular-nums"
          aria-label="Montant du fond de caisse"
          aria-live="polite"
        >
          {formatMoney(amountCents ?? 0)}
        </output>

        <div className="mt-5 grid grid-cols-3 gap-2" aria-label="Pavé numérique">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
            <Button
              key={digit}
              variant="secondary"
              className="min-h-16 text-2xl"
              disabled={busy}
              onClick={() => {
                setError(null)
                setAmountCents((amount) => appendCashDigits(amount, digit, Number.MAX_SAFE_INTEGER))
              }}
            >
              {digit}
            </Button>
          ))}
          <Button
            variant="secondary"
            className="min-h-16"
            disabled={busy}
            onClick={() => setAmountCents(null)}
          >
            Effacer
          </Button>
          <Button
            variant="secondary"
            className="min-h-16 text-2xl"
            disabled={busy}
            onClick={() => {
              setError(null)
              setAmountCents((amount) => appendCashDigits(amount, 0, Number.MAX_SAFE_INTEGER))
            }}
          >
            0
          </Button>
          <Button
            variant="secondary"
            className="min-h-16"
            disabled={busy}
            onClick={() => setAmountCents(deleteLastCashDigit)}
          >
            Corriger
          </Button>
        </div>

        {error ? (
          <p
            className="mt-4 border border-rose-300 bg-rose-50 p-4 font-bold text-rose-950"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className={`mt-6 grid gap-3 ${onCancel ? 'grid-cols-2' : ''}`}>
          {onCancel ? (
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              Annuler
            </Button>
          ) : null}
          <Button
            className="min-h-14"
            disabled={amountCents === null || busy}
            onClick={() => setConfirming(true)}
          >
            {mode === 'opening' ? 'Valider le fond de caisse' : 'Enregistrer le nouveau fond'}
          </Button>
        </div>
        {onManageTerminal ? (
          <Button
            variant="secondary"
            className="mt-3 w-full"
            disabled={busy}
            onClick={onManageTerminal}
          >
            Changer la caisse utilisée
          </Button>
        ) : null}
      </section>

      {confirming && amountCents !== null ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-stone-950/70 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cash-float-confirm-title"
        >
          <section className="w-full max-w-md border border-stone-300 bg-[#fffdf8] p-6">
            <h3 id="cash-float-confirm-title" className="text-2xl font-black">
              Confirmer le fond de caisse de {formatMoney(amountCents)} ?
            </h3>
            <p className="mt-3 font-semibold text-stone-700">
              Vérifiez le montant compté dans le tiroir avant de continuer.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Retour
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Enregistrement…' : 'Confirmer'}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
