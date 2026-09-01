import { productCategories, type ProductCategory } from '../../types/catalog'

export type CategoryFilter = 'Tout' | ProductCategory

type CategoryTabsProps = {
  activeCategory: CategoryFilter
  onChange: (category: CategoryFilter) => void
}

export function CategoryTabs({ activeCategory, onChange }: CategoryTabsProps) {
  const categories: CategoryFilter[] = ['Tout', ...productCategories]

  return (
    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Filtrer le catalogue">
      {categories.map((category) => {
        const active = activeCategory === category
        return (
          <button
            key={category}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(category)}
            className={`min-h-12 shrink-0 rounded-xl border px-4 py-2 text-sm font-extrabold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
              active
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100'
            }`}
          >
            {category}
          </button>
        )
      })}
    </div>
  )
}
