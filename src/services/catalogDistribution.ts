import type { Category, Product } from '../types/catalog.ts'
import type {
  CatalogContent,
  CatalogConflict,
  CatalogPublication,
  CatalogVersion,
} from '../types/catalogDistribution.ts'
import { canonicalJson, sha256Hex } from '../utils/integrity.ts'
import { validateCategory } from './categoryValidation.ts'
import { validateProduct } from './productValidation.ts'

export const MAX_CATALOG_BYTES = 450_000
const fail = (): never => {
  throw new Error('La version du catalogue est invalide. Le catalogue local est conservé.')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value !== value.trim())
    fail()
}
function flag(value: unknown): void {
  if (typeof value !== 'boolean') fail()
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail()
}
function confidence(value: unknown): void {
  if (value !== undefined && value !== 'confirmed' && value !== 'temporary') fail()
}
function unique(rows: { id: string }[]): void {
  if (new Set(rows.map(({ id }) => id)).size !== rows.length) fail()
}

// Runtime validation shared by the tablet, web cache and publication Edge Function.
export function validateCatalogContent(value: unknown, published = true): CatalogContent {
  const source = record(value)
  if (
    !Array.isArray(source.products) ||
    !Array.isArray(source.categories) ||
    source.products.length > 2000 ||
    source.categories.length > 200
  )
    fail()
  const categories: Category[] = []
  for (const row of source.categories as unknown[]) {
    const category = record(row)
    keys(category, ['id', 'label', 'active', 'displayOrder'])
    text(category.id)
    text(category.label)
    flag(category.active)
    categories.push(validateCategory(category as Category, categories))
  }
  unique(categories)
  const products = (source.products as unknown[]).map((row) => {
    const p = record(row)
    keys(p, [
      'id',
      'name',
      'categoryId',
      'active',
      'displayOrder',
      'requiresPreparation',
      'availability',
      'priceCents',
      'vatRate',
      'description',
      'variants',
      'optionGroups',
      'ingredients',
      'dataConfidence',
      'note',
    ])
    if (published && ('localAvailability' in p || 'centralAvailability' in p)) fail()
    text(p.id)
    text(p.name)
    text(p.categoryId)
    flag(p.active)
    flag(p.requiresPreparation)
    confidence(p.dataConfidence)
    if (published && p.dataConfidence !== 'confirmed') fail()
    if (!['available', 'sold-out'].includes(String(p.availability))) fail()
    for (const key of ['description', 'note'])
      if (p[key] !== undefined && (typeof p[key] !== 'string' || (p[key] as string).length > 4000))
        fail()
    for (const key of ['variants', 'optionGroups', 'ingredients'])
      if (p[key] !== undefined && (!Array.isArray(p[key]) || (p[key] as unknown[]).length > 100))
        fail()
    for (const raw of (p.variants ?? []) as unknown[]) {
      const v = record(raw)
      text(v.id)
      text(v.name)
      confidence(v.dataConfidence)
      keys(v, ['id', 'name', 'volume', 'priceCents', 'dataConfidence', 'note'])
      if (published && v.dataConfidence !== 'confirmed') fail()
      if (v.volume !== undefined && typeof v.volume !== 'string') fail()
      if (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > 4000)) fail()
    }
    for (const raw of (p.optionGroups ?? []) as unknown[]) {
      const g = record(raw)
      text(g.id)
      text(g.name)
      flag(g.required)
      keys(g, ['id', 'name', 'type', 'required', 'options'])
      if (
        !['single', 'multiple'].includes(String(g.type)) ||
        !Array.isArray(g.options) ||
        g.options.length > 100
      )
        fail()
      for (const rawOption of g.options as unknown[]) {
        const option = record(rawOption)
        text(option.id)
        text(option.name)
        keys(option, ['id', 'name', 'priceDeltaCents', 'default'])
        if (option.default !== undefined) flag(option.default)
      }
    }
    for (const raw of (p.ingredients ?? []) as unknown[]) {
      const ingredient = record(raw)
      keys(ingredient, ['id', 'name'])
      text(ingredient.id)
      text(ingredient.name)
    }
    const product = validateProduct(p as Product)
    if (!categories.some(({ id }) => id === product.categoryId)) fail()
    return product
  })
  unique(products)
  return { products, categories }
}

export function readCatalogVersion(
  value: unknown,
  scope?: { organizationId: string; festivalId: string },
): CatalogPublication {
  const envelope = record(value)
  if (
    typeof envelope.payload !== 'string' ||
    new TextEncoder().encode(envelope.payload).length > MAX_CATALOG_BYTES ||
    typeof envelope.sha256 !== 'string' ||
    sha256Hex(envelope.payload) !== envelope.sha256
  )
    fail()
  const document = record(JSON.parse(envelope.payload as string))
  keys(document, [
    'id',
    'revision',
    'schemaVersion',
    'publishedAt',
    'organizationId',
    'festivalId',
    'origin',
    'products',
    'categories',
  ])
  for (const key of ['id', 'organizationId', 'festivalId', 'origin']) text(document[key])
  if (
    document.schemaVersion !== 1 ||
    !Number.isSafeInteger(document.revision) ||
    (document.revision as number) < 1 ||
    typeof document.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(document.publishedAt))
  )
    fail()
  if (
    scope &&
    (scope.organizationId !== document.organizationId || scope.festivalId !== document.festivalId)
  )
    fail()
  return { ...document, ...validateCatalogContent(document) } as CatalogPublication
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

// Arrays (variants/options/compositions) are one field: no invented partial composition.
// Local availability is a separate overlay; the central value only restricts it.
export function mergeCatalog(
  base: CatalogContent,
  local: CatalogContent,
  remote: CatalogContent,
): {
  content: CatalogContent
  conflicts: CatalogConflict[]
} {
  const conflicts: CatalogConflict[] = []
  function merge<T extends Product | Category>(
    entity: 'products' | 'categories',
    previous: T[],
    current: T[],
    incoming: T[],
  ): T[] {
    const result = current.map((row) => structuredClone(row))
    for (const next of incoming) {
      const index = result.findIndex(({ id }) => id === next.id)
      const here = result[index]
      const before = previous.find(({ id }) => id === next.id)
      if (!here) {
        result.push({
          ...structuredClone(next),
          ...(entity === 'products' ? { availability: 'available' } : {}),
        })
        continue
      }
      const merged = { ...here } as Record<string, unknown>
      for (const field of new Set([
        ...Object.keys(here),
        ...Object.keys(next),
        ...Object.keys(before ?? {}),
      ])) {
        if (field === 'id' || (entity === 'products' && field === 'availability')) continue
        const b = before ? (before as Record<string, unknown>)[field] : undefined
        const l = (here as Record<string, unknown>)[field]
        const r = (next as Record<string, unknown>)[field]
        if (same(l, b) || same(l, r)) merged[field] = r
        else if (!same(r, b))
          conflicts.push({
            entity,
            id: here.id,
            field,
            base: b ?? null,
            local: l ?? null,
            remote: r ?? null,
          })
      }
      result[index] = merged as T
    }
    // Omission is not deletion. Publishers deactivate products/categories explicitly.
    return result
  }
  const content = {
    products: merge('products', base.products, local.products, remote.products),
    categories: merge('categories', base.categories, local.categories, remote.categories),
  }
  // Cross-field conflicts (e.g. two categories renamed to the same label) reject the whole activation.
  validateCatalogContent(content, false)
  return { content, conflicts }
}

export function effectiveProducts(content: CatalogContent, active?: CatalogVersion): Product[] {
  const central = active ? readCatalogVersion(active).products : []
  return content.products.map((product) => {
    const availability = central.find(({ id }) => id === product.id)?.availability
    return availability
      ? {
          ...product,
          localAvailability: product.availability,
          centralAvailability: availability,
          availability: availability === 'sold-out' ? 'sold-out' : product.availability,
        }
      : product
  })
}
