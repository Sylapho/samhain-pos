import type { Category } from '../types/catalog'

export const witchesCategories: readonly Category[] = [
  { id: 'potions', label: 'Potions', active: true, displayOrder: 0 },
  { id: 'gourmandises', label: 'Gourmandises', active: true, displayOrder: 1 },
  { id: 'petit-marche', label: 'Le petit marché', active: true, displayOrder: 2 },
]
