import { describe, expect, it } from 'vitest'
import {
  defaultCatalogProfile,
  loadCatalogProfile,
  saveCatalogProfile,
} from './catalogProfileService'

describe('sélection du catalogue', () => {
  it('ouvre Potion Bar par défaut', () => {
    expect(loadCatalogProfile(new MemoryStorage())).toBe(defaultCatalogProfile)
  })

  it('conserve le catalogue choisi sur la tablette', () => {
    const storage = new MemoryStorage()
    saveCatalogProfile('base', storage)
    expect(loadCatalogProfile(storage)).toBe('base')
  })

  it('ignore une valeur de stockage inconnue', () => {
    const storage = new MemoryStorage()
    storage.setItem('samhain-pos:catalog-profile', 'inconnu')
    expect(loadCatalogProfile(storage)).toBe(defaultCatalogProfile)
  })
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}
