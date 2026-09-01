import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet'

type ButtonProps = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    fullWidth?: boolean
  }
>

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-500 disabled:border-slate-300',
  secondary:
    'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 active:bg-slate-100 disabled:bg-slate-100 disabled:text-slate-400',
  danger:
    'bg-white text-red-700 border-red-200 hover:bg-red-50 active:bg-red-100 disabled:text-slate-400 disabled:border-slate-200',
  quiet:
    'bg-slate-100 text-slate-800 border-slate-200 hover:bg-slate-200 active:bg-slate-300 disabled:text-slate-400',
}

export function Button({
  children,
  className = '',
  variant = 'secondary',
  fullWidth = false,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`min-h-12 rounded-xl border px-5 py-3 text-base font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
