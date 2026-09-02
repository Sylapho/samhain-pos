import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { Product, ProductOptionGroup, ProductSelection } from '../../types/catalog'
import { getDefaultProductSelection, getProductStartingPriceCents } from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type ProductOptionsSheetProps = {
  product: Product
  mode?: 'add' | 'edit'
  quantity?: number
  initialSelection?: ProductSelection
  initialRemovedIngredientIds?: string[]
  onCancel: () => void
  onConfirm: (selection: ProductSelection, removedIngredientIds: string[]) => void
}

export function ProductOptionsSheet({
  product,
  mode = 'add',
  quantity = 1,
  initialSelection,
  initialRemovedIngredientIds = [],
  onCancel,
  onConfirm,
}: ProductOptionsSheetProps) {
  const defaults = useMemo(() => getDefaultProductSelection(product), [product])
  const [variantId, setVariantId] = useState<string | undefined>(
    initialSelection?.variantId ?? defaults.variantId,
  )
  const [optionIdsByGroup, setOptionIdsByGroup] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      Object.entries(initialSelection?.optionIdsByGroup ?? defaults.optionIdsByGroup).map(
        ([groupId, optionIds]) => [groupId, [...optionIds]],
      ),
    ),
  )
  const [presentIngredientIds, setPresentIngredientIds] = useState(
    () =>
      new Set(
        (product.ingredients ?? [])
          .filter((ingredient) => !initialRemovedIngredientIds.includes(ingredient.id))
          .map((ingredient) => ingredient.id),
      ),
  )

  const selectedVariant = product.variants?.find((variant) => variant.id === variantId)
  const missingRequiredGroups = (product.optionGroups ?? []).filter(
    (group) => group.required && !(optionIdsByGroup[group.id]?.length ?? 0),
  )
  const canConfirm =
    (!product.variants?.length || Boolean(selectedVariant)) && !missingRequiredGroups.length
  const configuredPrice = useMemo(() => {
    const basePrice =
      selectedVariant?.priceCents ?? product.priceCents ?? getProductStartingPriceCents(product)
    const optionTotal = (product.optionGroups ?? []).reduce((total, group) => {
      const selectedIds = new Set(optionIdsByGroup[group.id] ?? [])
      return (
        total +
        group.options
          .filter((option) => selectedIds.has(option.id))
          .reduce((sum, option) => sum + (option.priceDeltaCents ?? 0), 0)
      )
    }, 0)
    return basePrice + optionTotal
  }, [optionIdsByGroup, product, selectedVariant])

  const selectOption = (group: ProductOptionGroup, optionId: string) => {
    setOptionIdsByGroup((current) => {
      const selectedIds = current[group.id] ?? []
      if (group.type === 'single') {
        const nextIds = selectedIds.includes(optionId) && !group.required ? [] : [optionId]
        return { ...current, [group.id]: nextIds }
      }
      const nextIds = selectedIds.includes(optionId)
        ? selectedIds.filter((selectedId) => selectedId !== optionId)
        : [...selectedIds, optionId]
      return { ...current, [group.id]: nextIds }
    })
  }

  const toggleIngredient = (ingredientId: string) => {
    setPresentIngredientIds((current) => {
      const next = new Set(current)
      if (next.has(ingredientId)) next.delete(ingredientId)
      else next.add(ingredientId)
      return next
    })
  }

  const confirm = () => {
    if (!canConfirm) return
    const removedIngredientIds = (product.ingredients ?? [])
      .filter((ingredient) => !presentIngredientIds.has(ingredient.id))
      .map((ingredient) => ingredient.id)
    onConfirm({ variantId, optionIdsByGroup }, removedIngredientIds)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/65 sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="options-title"
    >
      <section className="max-h-[96dvh] w-full max-w-4xl overflow-y-auto rounded-t-2xl border border-stone-300 bg-[#fffdf8] sm:rounded-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-stone-300 bg-[#fffdf8] p-5 sm:p-6">
          <div>
            <h2 id="options-title" className="text-3xl font-black leading-tight">
              {product.name}
            </h2>
            {product.description ? (
              <p className="mt-1 font-medium text-stone-600">{product.description}</p>
            ) : null}
          </div>
          <Button variant="quiet" onClick={onCancel}>
            Fermer
          </Button>
        </header>

        <div className="space-y-7 p-5 sm:p-6">
          {product.variants?.length ? (
            <fieldset>
              <legend className="mb-3 text-xl font-black">Format *</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {product.variants.map((variant) => {
                  const selected = variant.id === variantId
                  return (
                    <SelectionButton
                      key={variant.id}
                      selected={selected}
                      label={variant.name}
                      detail={variant.volume}
                      price={formatMoney(variant.priceCents)}
                      onClick={() => setVariantId(variant.id)}
                    />
                  )
                })}
              </div>
            </fieldset>
          ) : null}

          {(product.optionGroups ?? []).map((group) => (
            <fieldset key={group.id}>
              <legend className="mb-3 text-xl font-black">
                {group.name}
                {group.required ? ' *' : ''}
              </legend>
              {group.type === 'multiple' ? (
                <p className="mb-2 text-sm font-bold text-stone-600">Plusieurs choix possibles</p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.options.map((option) => {
                  const selected = (optionIdsByGroup[group.id] ?? []).includes(option.id)
                  return (
                    <SelectionButton
                      key={option.id}
                      selected={selected}
                      label={option.name}
                      price={
                        option.priceDeltaCents
                          ? `+ ${formatMoney(option.priceDeltaCents)}`
                          : undefined
                      }
                      onClick={() => selectOption(group, option.id)}
                    />
                  )
                })}
              </div>
              {group.required && !optionIdsByGroup[group.id]?.length ? (
                <p className="mt-2 font-bold text-amber-800" role="status">
                  Choisissez une option.
                </p>
              ) : null}
            </fieldset>
          ))}

          {product.ingredients?.length ? (
            <fieldset>
              <legend className="mb-3 text-xl font-black">Composition</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {product.ingredients.map((ingredient) => {
                  const present = presentIngredientIds.has(ingredient.id)
                  return (
                    <label
                      key={ingredient.id}
                      className={`flex min-h-18 cursor-pointer items-center gap-4 rounded-xl border-2 px-4 py-3 text-lg font-black active:bg-stone-100 ${present ? 'border-[#315d48] bg-[#edf5f0]' : 'border-amber-400 bg-amber-50 text-amber-950'}`}
                    >
                      <input
                        type="checkbox"
                        className="size-7 shrink-0 accent-[#1f6a4b]"
                        checked={present}
                        onChange={() => toggleIngredient(ingredient.id)}
                      />
                      <span>{ingredient.name}</span>
                      {!present ? (
                        <span className="ml-auto text-sm uppercase" aria-hidden="true">
                          Retiré
                        </span>
                      ) : null}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ) : null}

          {mode === 'edit' && quantity > 1 ? (
            <p className="rounded-xl bg-sky-50 p-3 font-bold text-sky-950">
              La modification s’appliquera à une seule unité. La quantité sera séparée en deux
              lignes.
            </p>
          ) : null}
        </div>

        <footer className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-stone-300 bg-[#f6f1e7] p-5 sm:p-6">
          <div>
            <div className="text-sm font-extrabold uppercase tracking-wide text-stone-600">
              Prix du produit
            </div>
            <div className="text-3xl font-black tabular-nums">{formatMoney(configuredPrice)}</div>
          </div>
          <div className="flex gap-3">
            <Button className="min-h-16" onClick={onCancel}>
              Annuler
            </Button>
            <Button
              variant="primary"
              className="min-h-16 min-w-44 text-xl"
              disabled={!canConfirm}
              onClick={confirm}
            >
              {canConfirm
                ? mode === 'add'
                  ? `Ajouter ${product.name}`
                  : 'Valider'
                : 'Choix requis'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}

type SelectionButtonProps = {
  selected: boolean
  label: string
  detail?: string
  price?: string
  onClick: () => void
}

function SelectionButton({ selected, label, detail, price, onClick }: SelectionButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-18 rounded-xl border-2 px-4 py-3 text-left text-lg font-extrabold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${
        selected
          ? 'border-[#234f3c] bg-[#e7f1eb] text-stone-950'
          : 'border-stone-300 bg-white text-stone-950 active:bg-stone-100'
      }`}
    >
      <span className="flex items-center justify-between gap-3">
        <span>
          <span className="block">{label}</span>
          {detail ? <span className="mt-1 block text-sm text-stone-600">{detail}</span> : null}
        </span>
        {price ? <span className="shrink-0 tabular-nums">{price}</span> : null}
      </span>
      {selected ? (
        <span className="mt-1 block text-sm font-bold text-[#185b40]">Sélectionné</span>
      ) : null}
    </button>
  )
}
