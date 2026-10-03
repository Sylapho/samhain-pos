import { catalogProfiles, type CatalogProfile } from '../types/catalog'

const STORAGE_KEY = 'samhain-pos:catalog-profile'
export const defaultCatalogProfile: CatalogProfile = 'potion-bar'

export function loadCatalogProfile(storage: Storage = globalThis.localStorage): CatalogProfile {
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return catalogProfiles.includes(stored as CatalogProfile)
      ? (stored as CatalogProfile)
      : defaultCatalogProfile
  } catch {
    return defaultCatalogProfile
  }
}

export function saveCatalogProfile(
  profile: CatalogProfile,
  storage: Storage = globalThis.localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, profile)
  } catch {
    // La sélection reste utilisable pour la session même si le stockage WebView est indisponible.
  }
}
