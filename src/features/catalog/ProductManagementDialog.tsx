import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { CatalogService } from '../../services/catalogService'
import {
  productCategories,
  type CategoryId,
  type Product,
  type ProductIngredient,
  type ProductVariant,
  type VatRate,
} from '../../types/catalog'
import { getProductStartingPriceCents } from '../../utils/cart'
import { formatMoney } from '../../utils/money'

type Props = {
  products: Product[]
  service: CatalogService
  onProductsChanged: (products: Product[]) => void
  onClose: () => void
}

type EditorState = {
  product: Product
  price: string
  variantPrices: Record<string, string>
  ingredientNames: string
  isNew: boolean
}

function centsToInput(cents: number | undefined): string {
  if (cents === undefined) return ''
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`
}

function inputToCents(value: string, label: string): number {
  const match = value
    .trim()
    .replace('.', ',')
    .match(/^(\d+)(?:,(\d{1,2}))?$/)
  if (!match) throw new Error(`${label} doit être un montant valide.`)
  const euros = Number(match[1])
  const cents = Number((match[2] ?? '').padEnd(2, '0'))
  const total = euros * 100 + cents
  if (!Number.isSafeInteger(total)) throw new Error(`${label} est trop élevé.`)
  return total
}

function editableProduct(product: Product, isNew = false): EditorState {
  return {
    product: structuredClone(product),
    price: centsToInput(product.priceCents),
    variantPrices: Object.fromEntries(
      (product.variants ?? []).map((variant) => [variant.id, centsToInput(variant.priceCents)]),
    ),
    ingredientNames: (product.ingredients ?? []).map(({ name }) => name).join('\n'),
    isNew,
  }
}

function newProduct(displayOrder: number): EditorState {
  return editableProduct(
    {
      id: globalThis.crypto.randomUUID(),
      name: '',
      categoryId: 'assiettes',
      active: true,
      displayOrder,
      requiresPreparation: true,
      availability: 'available',
      priceCents: 0,
      vatRate: 10,
    },
    true,
  )
}

function ingredientsFromInput(value: string, previous: ProductIngredient[]): ProductIngredient[] {
  const existingByName = new Map(previous.map((ingredient) => [ingredient.name, ingredient.id]))
  return [
    ...new Set(
      value
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].map((name) => ({
    id: existingByName.get(name) ?? globalThis.crypto.randomUUID(),
    name,
  }))
}

export function ProductManagementDialog({ products, service, onProductsChanged, onClose }: Props) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sortedProducts = useMemo(
    () =>
      [...products].sort(
        (left, right) =>
          left.displayOrder - right.displayOrder || left.name.localeCompare(right.name, 'fr-FR'),
      ),
    [products],
  )

  const refresh = async () => onProductsChanged(await service.getProducts())

  const save = async () => {
    if (!editor) return
    setBusyId(editor.product.id)
    setError(null)
    try {
      const product: Product = {
        ...editor.product,
        priceCents: editor.product.variants?.length
          ? undefined
          : inputToCents(editor.price, 'Le prix'),
        variants: editor.product.variants?.map((variant) => ({
          ...variant,
          priceCents: inputToCents(
            editor.variantPrices[variant.id] ?? '',
            `Le prix de « ${variant.name || 'la variante'} »`,
          ),
        })),
        ingredients: ingredientsFromInput(editor.ingredientNames, editor.product.ingredients ?? []),
      }
      if (editor.isNew) await service.createProduct(product)
      else await service.updateProduct(product)
      await refresh()
      setEditor(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Le produit n’a pas pu être enregistré.')
    } finally {
      setBusyId(null)
    }
  }

  const toggleActive = async (product: Product) => {
    setBusyId(product.id)
    setError(null)
    try {
      await service.setProductActive(product, !product.active)
      await refresh()
    } catch {
      setError('Le changement d’état n’a pas pu être enregistré. Réessayez.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-stone-950/65 p-3 sm:p-6" role="presentation">
      <section
        className="m-auto flex max-h-full w-full max-w-6xl flex-col rounded-[12px] border border-stone-300 bg-[#fffdf8]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-admin-title"
      >
        <header className="flex items-center justify-between gap-4 border-b border-stone-300 p-4 sm:px-6">
          <div>
            <div className="text-sm font-black uppercase tracking-wide text-stone-600">
              Administration
            </div>
            <h2 id="catalog-admin-title" className="text-2xl font-black">
              Produits
            </h2>
          </div>
          <Button onClick={onClose}>Fermer</Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="flex items-center justify-between gap-4 border-b border-stone-300 pb-4">
            <p className="font-bold text-stone-700">
              {products.length} produit{products.length > 1 ? 's' : ''} enregistré
              {products.length > 1 ? 's' : ''} sur cette tablette
            </p>
            <Button
              variant="primary"
              onClick={() =>
                setEditor(newProduct(Math.max(-1, ...products.map((p) => p.displayOrder)) + 1))
              }
            >
              Ajouter un produit
            </Button>
          </div>

          {error ? (
            <p
              className="mt-4 border border-red-300 bg-red-50 p-3 font-bold text-red-900"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {products.length === 0 ? (
            <p className="py-12 text-center font-bold text-stone-600">Aucun produit enregistré.</p>
          ) : (
            <div className="divide-y divide-stone-300">
              {sortedProducts.map((product) => (
                <article
                  key={product.id}
                  className="grid items-center gap-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto]"
                >
                  <div className="min-w-0">
                    <h3 className="truncate text-lg font-black">{product.name}</h3>
                    <p className="font-semibold text-stone-600">
                      {productCategories.find(({ id }) => id === product.categoryId)?.label} · TVA{' '}
                      {product.vatRate} %
                    </p>
                  </div>
                  <div>
                    <div className="font-black tabular-nums">
                      {product.variants?.length ? 'Dès ' : ''}
                      {formatMoney(getProductStartingPriceCents(product))}
                    </div>
                    <div
                      className={`text-sm font-bold ${product.active ? 'text-emerald-800' : 'text-stone-500'}`}
                    >
                      {!product.active
                        ? 'Désactivé'
                        : product.availability === 'sold-out'
                          ? 'En rupture'
                          : 'Disponible'}
                    </div>
                  </div>
                  <Button onClick={() => setEditor(editableProduct(product))}>Modifier</Button>
                  <Button
                    variant={product.active ? 'danger' : 'secondary'}
                    disabled={busyId === product.id}
                    onClick={() => void toggleActive(product)}
                  >
                    {product.active ? 'Désactiver' : 'Réactiver'}
                  </Button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {editor ? (
        <ProductEditor
          editor={editor}
          busy={busyId === editor.product.id}
          onChange={setEditor}
          onCancel={() => {
            setEditor(null)
            setError(null)
          }}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  )
}

type ProductEditorProps = {
  editor: EditorState
  busy: boolean
  onChange: (state: EditorState) => void
  onCancel: () => void
  onSave: () => void
}

function ProductEditor({ editor, busy, onChange, onCancel, onSave }: ProductEditorProps) {
  const updateProduct = (update: Partial<Product>) =>
    onChange({ ...editor, product: { ...editor.product, ...update } })
  const updateVariant = (index: number, update: Partial<ProductVariant>) =>
    updateProduct({
      variants: editor.product.variants?.map((variant, candidate) =>
        candidate === index ? { ...variant, ...update } : variant,
      ),
    })

  return (
    <div className="fixed inset-0 z-60 flex items-end bg-stone-950/60 sm:items-center sm:p-5">
      <form
        className="max-h-full w-full overflow-y-auto border border-stone-300 bg-[#fffdf8] p-5 sm:m-auto sm:max-w-2xl sm:rounded-[12px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-editor-title"
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
      >
        <h3 id="product-editor-title" className="text-2xl font-black">
          {editor.isNew ? 'Ajouter un produit' : `Modifier ${editor.product.name}`}
        </h3>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="font-bold sm:col-span-2">
            Nom
            <input
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.product.name}
              onChange={(event) => updateProduct({ name: event.target.value })}
              required
            />
          </label>
          <label className="font-bold">
            Catégorie
            <select
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.product.categoryId}
              onChange={(event) => updateProduct({ categoryId: event.target.value as CategoryId })}
            >
              {productCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
          <label className="font-bold">
            TVA
            <select
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.product.vatRate}
              onChange={(event) =>
                updateProduct({ vatRate: Number(event.target.value) as VatRate })
              }
            >
              <option value={10}>10 %</option>
              <option value={20}>20 %</option>
            </select>
          </label>
          <label className="font-bold sm:col-span-2">
            Description
            <input
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.product.description ?? ''}
              onChange={(event) => updateProduct({ description: event.target.value })}
            />
          </label>
          <label className="font-bold">
            Ordre d’affichage
            <input
              type="number"
              min="0"
              step="1"
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.product.displayOrder}
              onChange={(event) => updateProduct({ displayOrder: Number(event.target.value) })}
            />
          </label>
          {!editor.product.variants?.length ? (
            <label className="font-bold">
              Prix TTC (€)
              <input
                inputMode="decimal"
                className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
                value={editor.price}
                onChange={(event) => onChange({ ...editor, price: event.target.value })}
                required
              />
            </label>
          ) : null}
        </div>

        <fieldset className="mt-5 border-t border-stone-300 pt-4">
          <legend className="font-black">État et préparation</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <CheckBox
              label="Produit actif"
              checked={editor.product.active}
              onChange={(active) => updateProduct({ active })}
            />
            <CheckBox
              label="Disponible"
              checked={editor.product.availability === 'available'}
              onChange={(available) =>
                updateProduct({ availability: available ? 'available' : 'sold-out' })
              }
            />
            <CheckBox
              label="À préparer"
              checked={editor.product.requiresPreparation}
              onChange={(requiresPreparation) => updateProduct({ requiresPreparation })}
            />
          </div>
        </fieldset>

        <section className="mt-5 border-t border-stone-300 pt-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-black">Variantes de prix</h4>
            <Button
              className="min-h-10 py-2"
              onClick={() => {
                const id = globalThis.crypto.randomUUID()
                onChange({
                  ...editor,
                  variantPrices: { ...editor.variantPrices, [id]: editor.price || '0,00' },
                  product: {
                    ...editor.product,
                    priceCents: undefined,
                    variants: [
                      ...(editor.product.variants ?? []),
                      {
                        id,
                        name: '',
                        priceCents: editor.product.priceCents ?? 0,
                      },
                    ],
                  },
                })
              }}
            >
              Ajouter une variante
            </Button>
          </div>
          {editor.product.variants?.map((variant, index) => (
            <div
              key={variant.id}
              className="mt-3 grid gap-2 border-l-4 border-stone-300 pl-3 sm:grid-cols-[1fr_120px_120px_auto]"
            >
              <input
                aria-label={`Nom variante ${index + 1}`}
                placeholder="Nom"
                className="min-h-11 rounded-[8px] border border-stone-400 px-3"
                value={variant.name}
                onChange={(event) => updateVariant(index, { name: event.target.value })}
              />
              <input
                aria-label={`Volume variante ${index + 1}`}
                placeholder="Volume"
                className="min-h-11 rounded-[8px] border border-stone-400 px-3"
                value={variant.volume ?? ''}
                onChange={(event) => updateVariant(index, { volume: event.target.value })}
              />
              <input
                aria-label={`Prix variante ${index + 1}`}
                inputMode="decimal"
                className="min-h-11 rounded-[8px] border border-stone-400 px-3"
                value={editor.variantPrices[variant.id] ?? ''}
                onChange={(event) =>
                  onChange({
                    ...editor,
                    variantPrices: { ...editor.variantPrices, [variant.id]: event.target.value },
                  })
                }
              />
              <Button
                variant="danger"
                className="min-h-11 py-2"
                onClick={() => {
                  const variants =
                    editor.product.variants?.filter((_, candidate) => candidate !== index) ?? []
                  const { [variant.id]: removedPrice, ...variantPrices } = editor.variantPrices
                  const removedPriceCents = inputToCents(removedPrice ?? '0', 'Le prix')
                  onChange({
                    ...editor,
                    variantPrices,
                    price: variants.length ? editor.price : centsToInput(removedPriceCents),
                    product: {
                      ...editor.product,
                      variants: variants.length ? variants : undefined,
                      priceCents: variants.length ? undefined : removedPriceCents,
                    },
                  })
                }}
              >
                Retirer
              </Button>
            </div>
          ))}
          {editor.product.optionGroups?.length ? (
            <p className="mt-3 bg-stone-100 p-3 text-sm font-semibold text-stone-700">
              {editor.product.optionGroups.length} groupe(s) de choix existant(s) seront conservés.
            </p>
          ) : null}
        </section>

        <label className="mt-5 block border-t border-stone-300 pt-4 font-bold">
          Ingrédients modifiables — un par ligne
          <textarea
            className="mt-1 min-h-28 w-full rounded-[8px] border border-stone-400 bg-white p-3"
            value={editor.ingredientNames}
            onChange={(event) => onChange({ ...editor, ingredientNames: event.target.value })}
          />
        </label>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button disabled={busy} onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function CheckBox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-12 items-center gap-3 rounded-[8px] border border-stone-300 bg-white px-3 font-bold">
      <input
        type="checkbox"
        className="h-6 w-6"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}
