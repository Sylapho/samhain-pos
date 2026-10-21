import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { CatalogService } from '../../services/catalogService'
import type { Category } from '../../types/catalog'

type Props = {
  categories: Category[]
  service: CatalogService
  onCategoriesChanged: (categories: Category[]) => void
  onBusyChanged: (busy: boolean) => void
}

export function CategoryManagement({
  categories,
  service,
  onCategoriesChanged,
  onBusyChanged,
}: Props) {
  const [editor, setEditor] = useState<{ id: string | null; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const write = async (operation: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    onBusyChanged(true)
    setError(null)
    try {
      await operation()
      onCategoriesChanged(await service.getCategories())
      setEditor(null)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'La modification n’a pas pu être enregistrée. Réessayez.',
      )
    } finally {
      pending.current = false
      setBusy(false)
      onBusyChanged(false)
    }
  }
  const move = (index: number, delta: number) => {
    const ids = categories.map(({ id }) => id)
    ;[ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!]
    void write(() => service.reorderCategories(ids))
  }

  return (
    <div aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-300 pb-4">
        <p className="font-bold">La désactivation conserve les produits et les ventes.</p>
        <Button
          variant="primary"
          disabled={busy || editor !== null}
          onClick={() => {
            setEditor({ id: null, label: '' })
            setError(null)
          }}
        >
          Ajouter une catégorie
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 border border-red-300 bg-red-50 p-3 font-bold text-red-900">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="py-3 font-bold">
          Enregistrement…
        </p>
      ) : null}
      {editor ? (
        <form
          className="grid gap-3 border-b border-stone-300 py-4 sm:grid-cols-[1fr_auto_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            void write(() =>
              editor.id === null
                ? service.createCategory(editor.label)
                : service.updateCategory(editor.id, editor.label),
            )
          }}
        >
          <label className="font-bold">
            Nom de la catégorie
            <input
              autoFocus
              className="mt-1 min-h-12 w-full rounded-[8px] border border-stone-400 bg-white px-3"
              value={editor.label}
              disabled={busy}
              onChange={(event) => setEditor({ ...editor, label: event.target.value })}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            Enregistrer
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setEditor(null)
              setError(null)
            }}
          >
            Annuler
          </Button>
        </form>
      ) : null}
      {!categories.length ? (
        <p className="py-5 font-bold">
          Aucune catégorie enregistrée. Ajoutez une catégorie pour classer vos produits.
        </p>
      ) : null}
      <ol className="divide-y divide-stone-300">
        {categories.map((category, index) => (
          <li
            key={category.id}
            className="flex flex-wrap items-center justify-between gap-3 py-4"
            aria-label={category.label}
          >
            <div className="min-w-40 flex-1">
              <h3 className="text-lg font-black">
                {index + 1}. {category.label}
              </h3>
              <p className="font-bold text-stone-700">{category.active ? 'Active' : 'Inactive'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || editor !== null}
                onClick={() => {
                  setEditor({ id: category.id, label: category.label })
                  setError(null)
                }}
              >
                Renommer
              </Button>
              <Button
                disabled={busy || editor !== null}
                variant={category.active ? 'danger' : 'secondary'}
                onClick={() =>
                  void write(() => service.setCategoryActive(category.id, !category.active))
                }
              >
                {category.active ? 'Désactiver' : 'Réactiver'}
              </Button>
              <Button
                disabled={busy || editor !== null || index === 0}
                onClick={() => move(index, -1)}
              >
                Monter
              </Button>
              <Button
                disabled={busy || editor !== null || index === categories.length - 1}
                onClick={() => move(index, 1)}
              >
                Descendre
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
