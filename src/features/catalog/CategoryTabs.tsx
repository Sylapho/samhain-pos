import { productCategories, type CategoryId } from '../../types/catalog'

type CategoryTabsProps = {
  activeCategory: CategoryId
  onChange: (category: CategoryId) => void
}

export function CategoryTabs({ activeCategory, onChange }: CategoryTabsProps) {
  return (
    <nav
      className="flex gap-2 overflow-x-auto p-3 lg:flex-col lg:overflow-visible lg:p-4"
      aria-label="Catégories de produits"
    >
      {productCategories.map((category) => {
        const active = activeCategory === category.id
        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(category.id)}
            className={`min-h-14 shrink-0 rounded-[8px] border px-4 py-3 text-left text-base font-extrabold leading-tight transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#216a9a] lg:w-full ${
              active
                ? 'border-[#183f31] bg-[#234f3c] text-white'
                : 'border-stone-300 bg-[#fffdf8] text-stone-800 active:bg-stone-100'
            }`}
          >
            <span className="block">{category.label}</span>
            {active ? (
              <span className="mt-1 block text-xs font-semibold text-[#d8eadf]">
                Catégorie active
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}
