import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('rend l’action secondaire d’en-tête lisible dans tous ses états', () => {
    render(
      <Button variant="headerSecondary" disabled>
        Fermer
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Fermer' })
    expect(button).toHaveClass(
      'bg-stone-100',
      'text-stone-950',
      'active:bg-stone-200',
      'disabled:bg-stone-700',
      'disabled:text-stone-300',
    )
  })

  it('distingue l’action importante d’en-tête sans sacrifier le contraste', () => {
    render(<Button variant="headerImportant">Clôture et sauvegarde</Button>)

    expect(screen.getByRole('button', { name: 'Clôture et sauvegarde' })).toHaveClass(
      'bg-amber-300',
      'text-stone-950',
      'active:bg-amber-400',
      'disabled:bg-stone-700',
      'disabled:text-stone-300',
    )
  })
})
