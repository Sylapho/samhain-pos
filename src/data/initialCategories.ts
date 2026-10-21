import type { Category } from '../types/catalog'

// Seeds only: these IDs remain stable for products already stored on tablets.
export const initialCategories: readonly Category[] = [
  { id: 'menus', label: 'Menus', active: true, displayOrder: 0 },
  { id: 'assiettes', label: 'Assiettes', active: true, displayOrder: 1 },
  { id: 'desserts', label: 'Desserts', active: true, displayOrder: 2 },
  { id: 'boissons-chaudes', label: 'Boissons chaudes', active: true, displayOrder: 3 },
  { id: 'bieres', label: 'Bières', active: true, displayOrder: 4 },
  { id: 'sans-alcool', label: 'Sans alcool', active: true, displayOrder: 5 },
]
