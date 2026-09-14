import { beforeEach, describe, expect, it } from 'vitest'
import {
  LocalStorageResponsibleCredentialRepository,
  RESPONSIBLE_FAILED_ATTEMPTS_BEFORE_DELAY,
  RESPONSIBLE_CREDENTIAL_STORAGE_KEY,
  RESPONSIBLE_MODE_IDLE_TIMEOUT_MS,
  RESPONSIBLE_RETRY_DELAY_MS,
  ResponsibleModeService,
} from './responsibleModeService'

describe('mode responsable local', () => {
  beforeEach(() => localStorage.clear())

  it('crée un credential dérivé sans persister le PIN en clair', async () => {
    const service = createService()
    expect(service.hasCredential()).toBe(false)
    expect(() => service.requireUnlocked()).toThrow(/Configurez d’abord le PIN responsable/)

    await service.setupPin('4826', '4826')

    expect(service.hasCredential()).toBe(true)
    const stored = localStorage.getItem(RESPONSIBLE_CREDENTIAL_STORAGE_KEY)
    expect(stored).not.toContain('4826')
    expect(JSON.parse(stored!)).toMatchObject({
      version: 1,
      algorithm: 'PBKDF2-SHA-256',
    })
  })

  it('refuse un mauvais PIN de même taille et accepte le bon', async () => {
    const service = createService()
    await service.setupPin('4826', '4826')
    service.lock()

    await expect(service.unlock('4827')).resolves.toBe(false)
    expect(service.isUnlocked()).toBe(false)
    await expect(service.unlock('4826')).resolves.toBe(true)
    expect(service.isUnlocked()).toBe(true)
  })

  it('verrouille explicitement et oublie la session après redémarrage', async () => {
    const service = createService()
    await service.setupPin('4826', '4826')
    service.lock()
    expect(service.isUnlocked()).toBe(false)

    await service.unlock('4826')
    const restarted = createService()
    expect(restarted.hasCredential()).toBe(true)
    expect(restarted.isUnlocked()).toBe(false)
    expect(() => restarted.requireUnlocked()).toThrow(/Mode responsable requis/)
  })

  it('expire avec une horloge injectable sans attente réelle', async () => {
    let now = 1_000
    const service = createService(() => now)
    await service.setupPin('4826', '4826')

    now += RESPONSIBLE_MODE_IDLE_TIMEOUT_MS - 1
    expect(() => service.requireUnlocked()).not.toThrow()
    now += RESPONSIBLE_MODE_IDLE_TIMEOUT_MS + 1
    expect(() => service.requireUnlocked()).toThrow(/expiré/)
    expect(service.isUnlocked()).toBe(false)
  })

  it('refuse les PIN non numériques, trop courts ou non confirmés', async () => {
    const service = createService()
    await expect(service.setupPin('12ab', '12ab')).rejects.toThrow(/4 à 8 chiffres/)
    await expect(service.setupPin('123', '123')).rejects.toThrow(/4 à 8 chiffres/)
    await expect(service.setupPin('4826', '4827')).rejects.toThrow(/ne correspondent pas/)
    expect(service.hasCredential()).toBe(false)
  })

  it('temporise brièvement après plusieurs tentatives incorrectes', async () => {
    let now = 1_000
    const service = createService(() => now)
    await service.setupPin('4826', '4826')
    service.lock()

    for (let attempt = 0; attempt < RESPONSIBLE_FAILED_ATTEMPTS_BEFORE_DELAY; attempt += 1) {
      await expect(service.unlock('4827')).resolves.toBe(false)
    }
    await expect(service.unlock('4826')).rejects.toThrow(/Trop de tentatives/)

    now += RESPONSIBLE_RETRY_DELAY_MS
    await expect(service.unlock('4826')).resolves.toBe(true)
  })
})

function createService(now?: () => number) {
  return new ResponsibleModeService(
    new LocalStorageResponsibleCredentialRepository(localStorage),
    globalThis.crypto,
    now,
  )
}
