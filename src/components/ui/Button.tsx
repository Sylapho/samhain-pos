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
    'border-[#185b40] bg-[#1f6a4b] text-white active:bg-[#174f39] disabled:border-stone-300 disabled:bg-stone-300 disabled:text-stone-500',
  secondary:
    'border-stone-300 bg-white text-stone-950 active:bg-stone-100 disabled:bg-stone-100 disabled:text-stone-400',
  danger:
    'border-red-300 bg-white text-red-800 active:bg-red-50 disabled:border-stone-200 disabled:text-stone-400',
  quiet: 'border-stone-300 bg-stone-100 text-stone-800 active:bg-stone-200 disabled:text-stone-400',
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
      className={`min-h-12 rounded-[10px] border px-5 py-3 text-base font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] disabled:cursor-not-allowed ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
