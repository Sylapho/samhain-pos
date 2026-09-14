import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import {
  RESPONSIBLE_PIN_MAX_LENGTH,
  RESPONSIBLE_PIN_MIN_LENGTH,
  ResponsibleModeError,
  type ResponsibleMode,
} from '../../services/responsibleModeService'

type Props = {
  responsibleMode: ResponsibleMode
  onUnlocked: () => void
  onCancel?: () => void
  requireSetup?: boolean
}

export function ResponsibleModeDialog({
  responsibleMode,
  onUnlocked,
  onCancel,
  requireSetup = false,
}: Props) {
  const setup = !responsibleMode.hasCredential()
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const clearSecrets = () => {
    setPin('')
    setConfirmation('')
  }

  const cancel = () => {
    clearSecrets()
    setError(null)
    responsibleMode.lock()
    onCancel?.()
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (setup) {
        await responsibleMode.setupPin(pin, confirmation)
        clearSecrets()
        onUnlocked()
        return
      }
      if (!(await responsibleMode.unlock(pin))) {
        clearSecrets()
        setError('PIN incorrect.')
        return
      }
      clearSecrets()
      onUnlocked()
    } catch (caught) {
      clearSecrets()
      setError(
        caught instanceof ResponsibleModeError
          ? caught.message
          : 'Le mode responsable reste verrouillé. Réessayez.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="responsible-mode-title"
    >
      <section className="w-full max-w-md rounded-[12px] border border-stone-300 bg-[#fffdf8] p-5 sm:p-7">
        <h2 id="responsible-mode-title" className="text-2xl font-black">
          {setup ? 'Configurer le mode responsable' : 'Mode responsable'}
        </h2>
        <p className="mt-2 font-bold text-stone-700">
          {setup
            ? `Créez un PIN local de ${RESPONSIBLE_PIN_MIN_LENGTH} à ${RESPONSIBLE_PIN_MAX_LENGTH} chiffres.`
            : 'Saisissez le PIN responsable pour continuer.'}
        </p>

        <label className="mt-5 block font-black" htmlFor="responsible-pin">
          {setup ? 'Nouveau PIN' : 'PIN responsable'}
        </label>
        <input
          id="responsible-pin"
          className="mt-2 min-h-14 w-full rounded-[8px] border border-stone-400 bg-white px-4 text-xl font-black tracking-[0.25em] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a]"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          minLength={RESPONSIBLE_PIN_MIN_LENGTH}
          maxLength={RESPONSIBLE_PIN_MAX_LENGTH}
          value={pin}
          disabled={busy}
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, '').slice(0, RESPONSIBLE_PIN_MAX_LENGTH))
            setError(null)
          }}
        />

        {setup ? (
          <>
            <label className="mt-4 block font-black" htmlFor="responsible-pin-confirmation">
              Confirmer le PIN
            </label>
            <input
              id="responsible-pin-confirmation"
              className="mt-2 min-h-14 w-full rounded-[8px] border border-stone-400 bg-white px-4 text-xl font-black tracking-[0.25em] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a]"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              minLength={RESPONSIBLE_PIN_MIN_LENGTH}
              maxLength={RESPONSIBLE_PIN_MAX_LENGTH}
              value={confirmation}
              disabled={busy}
              onChange={(event) => {
                setConfirmation(
                  event.target.value.replace(/\D/g, '').slice(0, RESPONSIBLE_PIN_MAX_LENGTH),
                )
                setError(null)
              }}
            />
          </>
        ) : null}

        {error ? (
          <p
            className="mt-4 border border-rose-300 bg-rose-50 p-3 font-bold text-rose-950"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          {!requireSetup ? (
            <Button disabled={busy} onClick={cancel}>
              Annuler
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            className="min-h-14 text-lg"
            disabled={
              busy ||
              pin.length < RESPONSIBLE_PIN_MIN_LENGTH ||
              (setup && confirmation.length < RESPONSIBLE_PIN_MIN_LENGTH)
            }
            onClick={() => void submit()}
          >
            {busy ? 'Vérification…' : setup ? 'Créer le PIN' : 'Déverrouiller'}
          </Button>
        </div>
      </section>
    </div>
  )
}
