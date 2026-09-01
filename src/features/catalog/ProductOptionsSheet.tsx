import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { Product, ProductSelection } from '../../types/catalog'
import { getProductStartingPriceCents } from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type ProductOptionsSheetProps = {
  product: Product
  onCancel: () => void
  onConfirm: (selection: ProductSelection) => void
}

export function ProductOptionsSheet({ product, onCancel, onConfirm }: ProductOptionsSheetProps) {
  const [variantId, setVariantId] = useState<string | undefined>(
    product.variants?.length === 1 ? product.variants[0]?.id : undefined,
  )
  const [optionIds, setOptionIds] = useState<Record<string, string>>({})

  const selectedVariant = product.variants?.find((variant) => variant.id === variantId)
  const allRequiredOptionsSelected = (product.optionGroups ?? []).every(
    (group) => !group.required || Boolean(optionIds[group.id]),
  )
  const canAdd =
    (!product.variants?.length || Boolean(selectedVariant)) && allRequiredOptionsSelected
  const configuredPrice = useMemo(() => {
    const basePrice =
      selectedVariant?.priceCents ?? product.priceCents ?? getProductStartingPriceCents(product)
    const optionTotal = (product.optionGroups ?? []).reduce((total, group) => {
      const selected = group.options.find((option) => option.id === optionIds[group.id])
      return total + (selected?.priceDeltaCents ?? 0)
    }, 0)
    return basePrice + optionTotal
  }, [optionIds, product, selectedVariant])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-stone-950/65 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="options-title"
    >
      <div className="max-h-[96dvh] w-full max-w-5xl overflow-y-auto rounded-[12px] border border-stone-300 bg-[#fffdf8]">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-stone-300 bg-[#fffdf8] p-5 sm:p-6">
          <div>
            <h2 id="options-title" className="text-3xl font-black leading-tight text-stone-950">
              {product.name}
            </h2>
            {product.description ? (
              <p className="mt-1 font-medium text-stone-600">{product.description}</p>
            ) : null}
          </div>
          <Button variant="quiet" onClick={onCancel}>
            Retour
          </Button>
        </div>

        <div className="space-y-7 p-5 sm:p-6">
          {product.variants?.length ? (
            <fieldset>
              <legend className="mb-3 text-xl font-black">Choisissez le format</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {product.variants.map((variant) => {
                  const selected = variant.id === variantId
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setVariantId(variant.id)}
                      className={`min-h-24 rounded-[10px] border-2 p-4 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${
                        selected
                          ? 'border-[#234f3c] bg-[#e7f1eb] text-stone-950'
                          : 'border-stone-300 bg-white text-stone-950 active:bg-stone-100'
                      }`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span>
                          <span className="block text-xl font-black">{variant.name}</span>
                          {variant.volume ? (
                            <span className="mt-1 block font-semibold text-stone-600">
                              {variant.volume}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xl font-black tabular-nums">
                          {formatMoney(variant.priceCents)}
                        </span>
                      </span>
                      {selected ? (
                        <span className="mt-2 block text-sm font-extrabold text-[#185b40]">
                          Choix sélectionné
                        </span>
                      ) : null}
                      {variant.dataConfidence === 'temporary' ? (
                        <span className="mt-1 block text-xs font-bold text-amber-800">
                          Prix temporaire à confirmer
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ) : null}

          {(product.optionGroups ?? []).map((group, index) => (
            <fieldset key={group.id}>
              <legend className="mb-3 text-xl font-black">
                {product.optionGroups && product.optionGroups.length > 1 ? `${index + 1}. ` : ''}
                {choicePrompt(group.id, group.name)}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.options.map((option) => {
                  const selected = optionIds[group.id] === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setOptionIds((current) => ({ ...current, [group.id]: option.id }))
                      }
                      className={`min-h-18 rounded-[10px] border-2 px-4 py-3 text-left text-lg font-extrabold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] ${
                        selected
                          ? 'border-[#234f3c] bg-[#e7f1eb] text-stone-950'
                          : 'border-stone-300 bg-white text-stone-950 active:bg-stone-100'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span>{option.name}</span>
                        {option.priceDeltaCents ? (
                          <span>+ {formatMoney(option.priceDeltaCents)}</span>
                        ) : null}
                      </span>
                      {selected ? (
                        <span className="mt-1 block text-sm font-bold text-[#185b40]">
                          Choix sélectionné
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="sticky bottom-0 flex flex-col gap-3 border-t border-stone-300 bg-[#f6f1e7] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <div className="text-sm font-extrabold uppercase tracking-wide text-stone-600">
              Prix du produit
            </div>
            <div className="text-3xl font-black tabular-nums">{formatMoney(configuredPrice)}</div>
          </div>
          <Button
            variant="primary"
            className="min-h-16 min-w-64 text-xl"
            disabled={!canAdd}
            onClick={() => onConfirm({ variantId, optionIds })}
          >
            {canAdd ? `Ajouter ${product.name}` : 'Terminez les choix'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function choicePrompt(groupId: string, groupName: string): string {
  if (groupId === 'boisson') return 'Choisissez la boisson'
  if (groupId === 'parfum') return 'Choisissez le parfum'
  return `Choisissez le ${groupName.toLocaleLowerCase('fr-FR')}`
}
