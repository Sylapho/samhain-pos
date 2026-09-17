import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type {
  TerminalCode,
  TerminalConfiguration,
  TerminalProvisioningInput,
} from '../../types/terminal'
import { terminalCodes } from '../../types/terminal'

type Props = {
  configuration: TerminalConfiguration | null
  onProvision: (input: TerminalProvisioningInput) => TerminalConfiguration
  onRename: (displayName: string) => TerminalConfiguration
  onReprovision: (input: TerminalProvisioningInput) => TerminalConfiguration
  onConfigured: (configuration: TerminalConfiguration) => void
  onClose?: () => void
  reprovisioningBlockReason?: string | null
}

export function TerminalConfigurationDialog({
  configuration,
  onProvision,
  onRename,
  onReprovision,
  onConfigured,
  onClose,
  reprovisioningBlockReason = null,
}: Props) {
  const [reprovisioning, setReprovisioning] = useState(false)
  const [terminalCode, setTerminalCode] = useState<TerminalCode | null>(
    configuration?.terminalCode ?? null,
  )
  const [displayName, setDisplayName] = useState(configuration?.displayName ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pendingReprovision, setPendingReprovision] = useState<TerminalProvisioningInput | null>(
    null,
  )
  const reprovisionSubmissionStarted = useRef(false)
  const isInitialProvisioning = configuration === null
  const isChoosingIdentity = isInitialProvisioning || reprovisioning

  const selectCode = (code: TerminalCode) => {
    setTerminalCode(code)
    setDisplayName(`Caisse ${code}`)
    setError(null)
  }

  const submit = () => {
    try {
      if (isChoosingIdentity) {
        if (!terminalCode) {
          setError('Sélectionnez le code de cette caisse.')
          return
        }
        const input = { terminalCode, displayName }
        if (isInitialProvisioning) {
          onConfigured(onProvision(input))
        } else {
          if (reprovisioningBlockReason) {
            setError(reprovisioningBlockReason)
            return
          }
          setPendingReprovision(input)
        }
        return
      }
      onConfigured(onRename(displayName))
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'La configuration n’a pas été enregistrée.',
      )
    }
  }

  const confirmReprovision = () => {
    if (!pendingReprovision || reprovisionSubmissionStarted.current) return
    reprovisionSubmissionStarted.current = true
    let updated: TerminalConfiguration
    try {
      updated = onReprovision(pendingReprovision)
    } catch (caught) {
      reprovisionSubmissionStarted.current = false
      setError(
        caught instanceof Error ? caught.message : 'La configuration n’a pas été enregistrée.',
      )
      return
    }
    onConfigured(updated)
  }

  if (configuration && pendingReprovision) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-reprovision-confirmation-title"
        onClick={() => {
          setPendingReprovision(null)
          setError(null)
        }}
      >
        <section
          className="my-auto w-full max-w-xl rounded-[12px] border border-stone-300 bg-[#fffdf8] p-5 sm:p-7"
          onClick={(event) => event.stopPropagation()}
        >
          <h1 id="terminal-reprovision-confirmation-title" className="text-2xl font-black">
            Changer cette tablette de Caisse {configuration.terminalCode} vers Caisse{' '}
            {pendingReprovision.terminalCode} ?
          </h1>
          <p className="mt-4 font-bold text-stone-800">
            Cette tablette sera désormais utilisée comme Caisse {pendingReprovision.terminalCode}.
            Les anciennes ventes resteront associées à Caisse {configuration.terminalCode}.
          </p>
          <dl className="mt-5 grid gap-3 border-y border-stone-300 py-4 font-bold sm:grid-cols-2">
            <div>
              <dt className="text-sm text-stone-600">Caisse actuelle</dt>
              <dd>{configuration.displayName}</dd>
              <dd>Code {configuration.terminalCode}</dd>
            </div>
            <div>
              <dt className="text-sm text-stone-600">Nouvelle caisse</dt>
              <dd>{pendingReprovision.displayName.trim()}</dd>
              <dd>Code {pendingReprovision.terminalCode}</dd>
            </div>
          </dl>
          {error ? (
            <p
              className="mt-4 border border-rose-300 bg-rose-50 p-3 font-bold text-rose-950"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-6 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <Button
              onClick={() => {
                setPendingReprovision(null)
                setError(null)
              }}
            >
              Annuler
            </Button>
            <Button variant="primary" className="min-h-14 text-lg" onClick={confirmReprovision}>
              Confirmer le changement
            </Button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terminal-configuration-title"
      onClick={() => {
        if (isInitialProvisioning) return
        if (reprovisioning) {
          setReprovisioning(false)
          setTerminalCode(configuration.terminalCode)
          setDisplayName(configuration.displayName)
          setError(null)
          return
        }
        onClose?.()
      }}
    >
      <section
        className="my-auto w-full max-w-xl rounded-[12px] border border-stone-300 bg-[#fffdf8] p-5 sm:p-7"
        onClick={(event) => event.stopPropagation()}
      >
        <h1 id="terminal-configuration-title" className="text-2xl font-black">
          {isInitialProvisioning
            ? 'Configurer cette tablette'
            : reprovisioning
              ? 'Changer la caisse de cette tablette'
              : 'Paramètres de la caisse'}
        </h1>
        <p className="mt-2 font-bold text-stone-700">
          {isChoosingIdentity
            ? 'Choisissez le code physique attribué à cette tablette. Cette opération fonctionne hors ligne.'
            : 'Vous pouvez modifier le nom affiché sans changer les anciennes commandes.'}
        </p>

        {configuration ? (
          <div className="mt-5 border-y border-stone-300 py-3 font-bold">
            <p className="text-sm text-stone-600">Caisse actuelle</p>
            <p>Nom : {configuration.displayName}</p>
            <p>Code : {configuration.terminalCode}</p>
          </div>
        ) : null}

        {isChoosingIdentity ? (
          <fieldset className="mt-5">
            <legend className="font-black">
              {reprovisioning ? 'Nouvelle caisse' : 'Code de la caisse'}
            </legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {terminalCodes.map((code) => (
                <Button
                  key={code}
                  className="min-h-16 text-xl"
                  variant={terminalCode === code ? 'primary' : 'secondary'}
                  aria-pressed={terminalCode === code}
                  onClick={() => selectCode(code)}
                >
                  {code}
                </Button>
              ))}
            </div>
          </fieldset>
        ) : null}

        <label className="mt-5 block font-black" htmlFor="terminal-display-name">
          Nom visible
        </label>
        <input
          id="terminal-display-name"
          className="mt-2 min-h-14 w-full rounded-[8px] border border-stone-400 bg-white px-4 text-lg font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a]"
          value={displayName}
          maxLength={40}
          autoComplete="off"
          onChange={(event) => {
            setDisplayName(event.target.value)
            setError(null)
          }}
        />

        {reprovisioning ? (
          <p className="mt-4 border border-amber-300 bg-amber-50 p-3 font-bold text-amber-950">
            Après ce changement, les nouvelles commandes seront rattachées à la caisse choisie. Les
            commandes déjà enregistrées conserveront leur caisse d’origine.
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-4 border border-rose-300 bg-rose-50 p-3 font-bold text-rose-950"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
          {!isInitialProvisioning ? (
            <Button
              onClick={() => {
                if (reprovisioning) {
                  setReprovisioning(false)
                  setTerminalCode(configuration.terminalCode)
                  setDisplayName(configuration.displayName)
                  setError(null)
                } else {
                  onClose?.()
                }
              }}
            >
              Annuler
            </Button>
          ) : null}
          <Button
            variant="primary"
            className="min-h-14 text-lg"
            disabled={!displayName.trim() || (isChoosingIdentity && !terminalCode)}
            onClick={submit}
          >
            {isInitialProvisioning
              ? 'Configurer la tablette'
              : reprovisioning
                ? 'Continuer'
                : 'Enregistrer le nom'}
          </Button>
        </div>

        {!isInitialProvisioning && !reprovisioning ? (
          <div className="mt-6 border-t border-stone-300 pt-5">
            <Button
              disabled={Boolean(reprovisioningBlockReason)}
              aria-describedby={
                reprovisioningBlockReason ? 'terminal-reprovision-block-reason' : undefined
              }
              onClick={() => {
                setReprovisioning(true)
                setError(null)
              }}
            >
              Changer la caisse utilisée
            </Button>
            {reprovisioningBlockReason ? (
              <p
                id="terminal-reprovision-block-reason"
                className="mt-3 font-bold text-amber-950"
                role="status"
              >
                {reprovisioningBlockReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
