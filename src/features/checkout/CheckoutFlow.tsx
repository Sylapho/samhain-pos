import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { PrinterStatus } from '../../types/system'
import { formatMoney } from '../../utils/money'

export type CheckoutStep = 'method' | 'card' | 'cash' | 'success'
type Props = { totalCents: number; printer: PrinterStatus; onClose: () => void; onComplete: () => void; initialStep?: CheckoutStep }

export function CheckoutFlow({ totalCents, printer, onClose, onComplete, initialStep = 'method' }: Props) {
  const [step, setStep] = useState<CheckoutStep>(initialStep)
  const [paymentMethod, setPaymentMethod] = useState<'CB' | 'Espèces' | null>(initialStep === 'success' ? 'CB' : null)
  const [received, setReceived] = useState('')
  const orderNumber = 'A042'
  const receivedCents = useMemo(() => Math.round((Number(received.replace(',', '.')) || 0) * 100), [received])
  const change = Math.max(0, receivedCents - totalCents)

  if (step === 'success') {
    const printerError = ['disconnected', 'paper-out', 'error'].includes(printer)
    return <Overlay title="Commande enregistrée"><div className="text-center"><div className="text-7xl font-black tracking-tight">{orderNumber}</div><div className="mt-3 text-3xl font-black">{formatMoney(totalCents)}</div><div className="mt-2 text-lg font-bold text-slate-600">{paymentMethod ?? 'Paiement de démonstration'}</div><div className="mt-6 rounded-2xl bg-emerald-50 p-5 text-lg font-bold text-emerald-900">La commande est bien enregistrée.</div>{printerError ? <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-left"><strong className="text-xl">Impression impossible</strong><p className="mt-1">La commande {orderNumber} n’est pas perdue.</p><div className="mt-4 flex gap-3"><Button>Réessayer</Button><Button variant="primary" onClick={onComplete}>Continuer</Button></div></div> : <><p className="mt-5 text-slate-600">Impression des tickets simulée…</p><Button variant="primary" fullWidth className="mt-6 min-h-16 text-xl" onClick={onComplete}>Nouvelle commande</Button></>}</div></Overlay>
  }

  return <Overlay title={step === 'method' ? 'Encaisser' : step === 'card' ? 'Paiement CB' : 'Paiement espèces'} onClose={onClose}>
    <div className="text-center text-5xl font-black tabular-nums">{formatMoney(totalCents)}</div>
    {step === 'method' && <div className="mt-8 grid gap-4 md:grid-cols-2"><Button className="min-h-28 text-2xl" onClick={() => setStep('card')}>CB</Button><Button className="min-h-28 text-2xl" onClick={() => setStep('cash')}>Espèces</Button></div>}
    {step === 'card' && <div className="mt-8"><div className="rounded-2xl bg-slate-100 p-6 text-center text-lg">Saisissez manuellement <strong>{formatMoney(totalCents)}</strong> sur le TPE, puis attendez son acceptation.</div><div className="mt-6 grid gap-3 md:grid-cols-2"><Button onClick={() => setStep('method')}>Retour</Button><Button variant="primary" className="min-h-16" onClick={() => { setPaymentMethod('CB'); setStep('success') }}>Paiement accepté</Button></div></div>}
    {step === 'cash' && <div className="mt-7"><label className="block text-sm font-black uppercase tracking-wide text-slate-500" htmlFor="received">Montant reçu</label><input id="received" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="20,00" className="mt-2 h-16 w-full rounded-xl border-2 border-slate-300 px-4 text-3xl font-black focus:border-sky-600 focus:outline-none"/><div className="mt-4 grid grid-cols-3 gap-3"><Button onClick={() => setReceived((totalCents / 100).toFixed(2))}>Exact</Button><Button onClick={() => setReceived('20')}>20 €</Button><Button onClick={() => setReceived('50')}>50 €</Button></div><div className="mt-6 rounded-2xl bg-slate-100 p-5"><div className="text-sm font-black uppercase tracking-wide text-slate-500">À rendre</div><div className="mt-1 text-4xl font-black tabular-nums">{formatMoney(change)}</div></div><div className="mt-6 grid gap-3 md:grid-cols-2"><Button onClick={() => setStep('method')}>Retour</Button><Button variant="primary" className="min-h-16" disabled={receivedCents < totalCents} onClick={() => { setPaymentMethod('Espèces'); setStep('success') }}>Valider le paiement</Button></div></div>}
  </Overlay>
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-5" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><div className="max-h-[94dvh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-7 shadow-2xl"><div className="mb-6 flex items-center justify-between gap-4"><h2 id="checkout-title" className="text-3xl font-black">{title}</h2>{onClose ? <Button variant="quiet" onClick={onClose}>Annuler</Button> : null}</div>{children}</div></div>
}
