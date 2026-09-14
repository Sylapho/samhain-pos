export const RESPONSIBLE_CREDENTIAL_STORAGE_KEY = 'samhain-pos.responsible-credential.v1'
export const RESPONSIBLE_CREDENTIAL_ITERATIONS = 310_000
export const RESPONSIBLE_MODE_IDLE_TIMEOUT_MS = 5 * 60 * 1_000
export const RESPONSIBLE_PIN_MIN_LENGTH = 4
export const RESPONSIBLE_PIN_MAX_LENGTH = 8
export const RESPONSIBLE_FAILED_ATTEMPTS_BEFORE_DELAY = 3
export const RESPONSIBLE_RETRY_DELAY_MS = 1_000

const DERIVED_KEY_LENGTH_BITS = 256
const SALT_LENGTH_BYTES = 16

export type ResponsibleCredential = {
  version: 1
  algorithm: 'PBKDF2-SHA-256'
  salt: string
  iterations: number
  derivedKey: string
}

export interface ResponsibleCredentialRepository {
  get(): ResponsibleCredential | null
  save(credential: ResponsibleCredential): void
}

export class LocalStorageResponsibleCredentialRepository implements ResponsibleCredentialRepository {
  constructor(private readonly storage: Storage) {}

  get(): ResponsibleCredential | null {
    const stored = this.storage.getItem(RESPONSIBLE_CREDENTIAL_STORAGE_KEY)
    if (!stored) return null

    try {
      const value: unknown = JSON.parse(stored)
      return isResponsibleCredential(value) ? value : null
    } catch {
      return null
    }
  }

  save(credential: ResponsibleCredential): void {
    this.storage.setItem(RESPONSIBLE_CREDENTIAL_STORAGE_KEY, JSON.stringify(credential))
  }
}

export type ResponsibleModeErrorCode =
  | 'credential-required'
  | 'already-configured'
  | 'invalid-pin-format'
  | 'pin-mismatch'
  | 'temporarily-blocked'
  | 'locked'
  | 'expired'

export class ResponsibleModeError extends Error {
  constructor(
    message: string,
    public readonly code: ResponsibleModeErrorCode,
  ) {
    super(message)
    this.name = 'ResponsibleModeError'
  }
}

export interface ResponsibleMode {
  hasCredential(): boolean
  setupPin(pin: string, confirmation: string): Promise<void>
  unlock(pin: string): Promise<boolean>
  lock(): void
  isUnlocked(): boolean
  requireUnlocked(): void
}

export class ResponsibleModeService implements ResponsibleMode {
  private unlockedAt: number | null = null
  private failedAttempts = 0
  private retryAfter = 0

  constructor(
    private readonly repository: ResponsibleCredentialRepository,
    private readonly crypto: Crypto = globalThis.crypto,
    private readonly now: () => number = () => Date.now(),
  ) {}

  hasCredential(): boolean {
    return this.repository.get() !== null
  }

  async setupPin(pin: string, confirmation: string): Promise<void> {
    if (this.hasCredential()) {
      throw new ResponsibleModeError(
        'Un PIN responsable est déjà configuré sur cette tablette.',
        'already-configured',
      )
    }
    validatePin(pin)
    if (pin !== confirmation) {
      throw new ResponsibleModeError(
        'Les deux saisies du PIN ne correspondent pas.',
        'pin-mismatch',
      )
    }

    const salt = this.crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES))
    const derivedKey = await derivePin(this.crypto, pin, salt, RESPONSIBLE_CREDENTIAL_ITERATIONS)
    this.repository.save({
      version: 1,
      algorithm: 'PBKDF2-SHA-256',
      salt: bytesToBase64(salt),
      iterations: RESPONSIBLE_CREDENTIAL_ITERATIONS,
      derivedKey: bytesToBase64(derivedKey),
    })
    this.unlockedAt = this.now()
  }

  async unlock(pin: string): Promise<boolean> {
    const credential = this.repository.get()
    if (!credential) {
      this.lock()
      throw new ResponsibleModeError(
        'Configurez d’abord le PIN responsable sur cette tablette.',
        'credential-required',
      )
    }

    validatePin(pin)
    if (this.now() < this.retryAfter) {
      throw new ResponsibleModeError(
        'Trop de tentatives incorrectes. Patientez un instant puis réessayez.',
        'temporarily-blocked',
      )
    }
    const actual = await derivePin(
      this.crypto,
      pin,
      base64ToBytes(credential.salt),
      credential.iterations,
    )
    const expected = base64ToBytes(credential.derivedKey)
    if (!constantTimeEqual(actual, expected)) {
      this.lock()
      this.failedAttempts += 1
      if (this.failedAttempts >= RESPONSIBLE_FAILED_ATTEMPTS_BEFORE_DELAY) {
        this.failedAttempts = 0
        this.retryAfter = this.now() + RESPONSIBLE_RETRY_DELAY_MS
      }
      return false
    }

    this.failedAttempts = 0
    this.retryAfter = 0
    this.unlockedAt = this.now()
    return true
  }

  lock(): void {
    this.unlockedAt = null
  }

  isUnlocked(): boolean {
    if (this.unlockedAt === null) return false
    if (this.now() - this.unlockedAt > RESPONSIBLE_MODE_IDLE_TIMEOUT_MS) {
      this.lock()
      return false
    }
    return true
  }

  requireUnlocked(): void {
    if (this.unlockedAt === null) {
      if (!this.hasCredential()) {
        throw new ResponsibleModeError(
          'Configurez d’abord le PIN responsable sur cette tablette.',
          'credential-required',
        )
      }
      throw new ResponsibleModeError('Mode responsable requis pour cette opération.', 'locked')
    }
    const currentTime = this.now()
    if (currentTime - this.unlockedAt > RESPONSIBLE_MODE_IDLE_TIMEOUT_MS) {
      this.lock()
      throw new ResponsibleModeError('Le mode responsable a expiré.', 'expired')
    }
    this.unlockedAt = currentTime
  }
}

function validatePin(pin: string): void {
  const valid = new RegExp(`^\\d{${RESPONSIBLE_PIN_MIN_LENGTH},${RESPONSIBLE_PIN_MAX_LENGTH}}$`)
  if (!valid.test(pin)) {
    throw new ResponsibleModeError(
      `Le PIN doit contenir ${RESPONSIBLE_PIN_MIN_LENGTH} à ${RESPONSIBLE_PIN_MAX_LENGTH} chiffres.`,
      'invalid-pin-format',
    )
  }
}

async function derivePin(
  crypto: Crypto,
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    DERIVED_KEY_LENGTH_BITS,
  )
  return new Uint8Array(bits)
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isResponsibleCredential(value: unknown): value is ResponsibleCredential {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ResponsibleCredential>
  return (
    candidate.version === 1 &&
    candidate.algorithm === 'PBKDF2-SHA-256' &&
    typeof candidate.salt === 'string' &&
    candidate.salt.length > 0 &&
    Number.isSafeInteger(candidate.iterations) &&
    (candidate.iterations ?? 0) > 0 &&
    typeof candidate.derivedKey === 'string' &&
    candidate.derivedKey.length > 0
  )
}

let defaultService: ResponsibleModeService | null = null

export function getResponsibleModeService(): ResponsibleModeService {
  if (!defaultService) {
    if (!globalThis.localStorage) {
      throw new Error('Le stockage local du mode responsable est indisponible sur cet appareil.')
    }
    defaultService = new ResponsibleModeService(
      new LocalStorageResponsibleCredentialRepository(globalThis.localStorage),
    )
  }
  return defaultService
}
