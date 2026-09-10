import type {
  TerminalCode,
  TerminalConfiguration,
  TerminalProvisioningInput,
} from '../types/terminal'
import { terminalCodes } from '../types/terminal'

const TERMINAL_CONFIGURATION_KEY = 'samhain-pos.terminal-configuration.v1'

export interface TerminalConfigurationRepository {
  get(): TerminalConfiguration | null
  save(configuration: TerminalConfiguration): void
}

export class LocalStorageTerminalConfigurationRepository implements TerminalConfigurationRepository {
  constructor(private readonly storage: Storage) {}

  get(): TerminalConfiguration | null {
    const value = this.storage.getItem(TERMINAL_CONFIGURATION_KEY)
    if (!value) return null

    try {
      const configuration: unknown = JSON.parse(value)
      return isTerminalConfiguration(configuration) ? configuration : null
    } catch {
      return null
    }
  }

  save(configuration: TerminalConfiguration): void {
    this.storage.setItem(TERMINAL_CONFIGURATION_KEY, JSON.stringify(configuration))
  }
}

export class TerminalConfigurationService {
  constructor(
    private readonly repository: TerminalConfigurationRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  getConfiguration(): TerminalConfiguration | null {
    return this.repository.get()
  }

  getRequiredConfiguration(): TerminalConfiguration {
    const configuration = this.getConfiguration()
    if (!configuration) {
      throw new Error('Cette tablette doit être configurée avant de pouvoir encaisser.')
    }
    return configuration
  }

  provision(input: TerminalProvisioningInput, provisionedAt = new Date()): TerminalConfiguration {
    if (this.getConfiguration()) {
      throw new Error(
        'Cette tablette est déjà configurée. Utilisez le reprovisionnement explicite.',
      )
    }
    return this.saveNewIdentity(input, provisionedAt)
  }

  rename(displayName: string): TerminalConfiguration {
    const current = this.getRequiredConfiguration()
    const configuration = { ...current, displayName: normalizeDisplayName(displayName) }
    this.repository.save(configuration)
    return configuration
  }

  reprovision(input: TerminalProvisioningInput, provisionedAt = new Date()): TerminalConfiguration {
    this.getRequiredConfiguration()
    return this.saveNewIdentity(input, provisionedAt)
  }

  private saveNewIdentity(
    input: TerminalProvisioningInput,
    provisionedAt: Date,
  ): TerminalConfiguration {
    const configuration: TerminalConfiguration = {
      terminalId: this.createId(),
      terminalCode: input.terminalCode,
      displayName: normalizeDisplayName(input.displayName),
      provisionedAt: provisionedAt.toISOString(),
    }
    this.repository.save(configuration)
    return configuration
  }
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim()
  if (!normalized) throw new Error('Le nom visible de la caisse est obligatoire.')
  if (normalized.length > 40) throw new Error('Le nom visible est limité à 40 caractères.')
  return normalized
}

function isTerminalConfiguration(value: unknown): value is TerminalConfiguration {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TerminalConfiguration>
  return (
    typeof candidate.terminalId === 'string' &&
    candidate.terminalId.length > 0 &&
    terminalCodes.includes(candidate.terminalCode as TerminalCode) &&
    typeof candidate.displayName === 'string' &&
    candidate.displayName.trim().length > 0 &&
    candidate.displayName.length <= 40 &&
    typeof candidate.provisionedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.provisionedAt))
  )
}

let defaultService: TerminalConfigurationService | null = null

export function getTerminalConfigurationService(): TerminalConfigurationService {
  if (!defaultService) {
    if (!globalThis.localStorage) {
      throw new Error('Le stockage local de configuration est indisponible sur cet appareil.')
    }
    defaultService = new TerminalConfigurationService(
      new LocalStorageTerminalConfigurationRepository(globalThis.localStorage),
    )
  }
  return defaultService
}

export function getTerminalConfiguration(): TerminalConfiguration | null {
  return getTerminalConfigurationService().getConfiguration()
}

export function getRequiredTerminalConfiguration(): TerminalConfiguration {
  return getTerminalConfigurationService().getRequiredConfiguration()
}

export function provisionTerminal(input: TerminalProvisioningInput): TerminalConfiguration {
  return getTerminalConfigurationService().provision(input)
}

export function renameTerminal(displayName: string): TerminalConfiguration {
  return getTerminalConfigurationService().rename(displayName)
}

export function reprovisionTerminal(input: TerminalProvisioningInput): TerminalConfiguration {
  return getTerminalConfigurationService().reprovision(input)
}
