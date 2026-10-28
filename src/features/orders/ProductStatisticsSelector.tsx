import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../components/ui/Button'
import { useVisibleViewport } from '../../components/ui/useVisibleViewport'

type Props = {
  products: { id: string; name: string }[]
  selection: Set<string>
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
}

export function ProductStatisticsSelector({
  products,
  selection,
  onToggle,
  onSelectAll,
  onClear,
}: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const viewport = useVisibleViewport()
  const id = useId()
  const count = products.filter(({ id }) => selection.has(id)).length
  const visible = products.filter(({ name }) =>
    name.toLocaleLowerCase('fr-FR').includes(search.trim().toLocaleLowerCase('fr-FR')),
  )

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const margin = 12
      const width = Math.min(420, viewport.width - margin * 2)
      const bottom = viewport.top + viewport.height - margin
      const below = bottom - anchor.bottom - 8
      const above = anchor.top - viewport.top - margin - 8
      const height = Math.min(440, viewport.height - margin * 2, Math.max(below, above))
      // With the keyboard open, use the visible area if neither side has enough room.
      const useVisibleArea = height < 240
      setPosition({
        left: Math.max(
          viewport.left + margin,
          Math.min(anchor.left, viewport.left + viewport.width - width - margin),
        ),
        top: useVisibleArea
          ? viewport.top + margin
          : Math.max(
              viewport.top + margin,
              Math.min(
                bottom - height,
                below >= above ? anchor.bottom + 8 : anchor.top - 8 - height,
              ),
            ),
        width,
        maxHeight: useVisibleArea ? viewport.height - margin * 2 : height,
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    return () => window.removeEventListener('scroll', update, true)
  }, [open, viewport])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className="min-h-12 rounded-[10px] border border-stone-400 bg-white px-4 py-2 text-left font-bold focus-visible:outline-3 focus-visible:outline-[#216a9a]"
      >
        Produits sélectionnés ({count})
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-label="Sélection des produits"
              tabIndex={-1}
              style={position}
              onClick={(event) => event.stopPropagation()}
              className="fixed z-50 flex min-h-0 flex-col overflow-y-auto rounded-[10px] border border-stone-400 bg-[#fffdf8] shadow-md"
            >
              <div className="shrink-0 border-b border-stone-300 p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong>
                    Produits ({count}/{products.length})
                  </strong>
                  <Button
                    className="px-3 py-2"
                    onClick={() => {
                      setOpen(false)
                      trigger.current?.focus()
                    }}
                  >
                    Terminer
                  </Button>
                </div>
                <label className="mt-2 block font-bold" htmlFor={`${id}-search`}>
                  Rechercher un produit
                </label>
                <input
                  id={`${id}-search`}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
                />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    className="px-2 py-2"
                    onClick={onSelectAll}
                    disabled={count === products.length}
                  >
                    Tout sélectionner
                  </Button>
                  <Button className="px-2 py-2" onClick={onClear} disabled={count === 0}>
                    Tout désélectionner
                  </Button>
                </div>
              </div>
              <fieldset className="min-h-12 shrink overflow-y-auto overscroll-contain p-2">
                <legend className="sr-only">Produits disponibles</legend>
                {visible.map((product) => (
                  <label
                    key={product.id}
                    className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2 font-bold has-checked:bg-emerald-50"
                  >
                    <input
                      type="checkbox"
                      checked={selection.has(product.id)}
                      onChange={() => onToggle(product.id)}
                      className="size-6 shrink-0 accent-[#1f6a4b]"
                    />
                    <span className="min-w-0 break-words">{product.name}</span>
                  </label>
                ))}
                {!visible.length ? (
                  <p className="p-3 font-bold text-stone-700">
                    {products.length ? 'Aucun produit trouvé.' : 'Aucun produit disponible.'}
                  </p>
                ) : null}
              </fieldset>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
