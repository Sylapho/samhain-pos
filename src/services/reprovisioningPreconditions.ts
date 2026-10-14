// #35 must supply a durable snapshot checked at the identity mutation boundary.
export type ReprovisioningSyncState = {
  pendingEvents: number
  transferring: boolean
  unresolvedError: boolean
  continuity: 'verified' | 'failed' | 'unknown'
}

export interface ReprovisioningPreconditions {
  requireSafeToReprovision(): void
  blockReason(): string | null
}

export class SyncReprovisioningPreconditions implements ReprovisioningPreconditions {
  constructor(private readonly read: () => ReprovisioningSyncState | null = () => null) {}
  blockReason(): string | null {
    const state = this.read()
    if (!state || state.continuity === 'unknown')
      return 'Le suivi des échanges n’est pas encore disponible (#35). Le changement de caisse est suspendu ; le renommage reste possible.'
    if (!Number.isSafeInteger(state.pendingEvents) || state.pendingEvents < 0)
      return 'Impossible de vérifier les événements en attente.'
    if (state.pendingEvents > 0)
      return 'Des événements ne sont pas acquittés. Conservez les données et attendez leur vérification.'
    if (state.transferring) return 'Un transfert est en cours. Attendez sa fin.'
    if (state.unresolvedError || state.continuity !== 'verified')
      return 'Une erreur ou une vérification de continuité exige une reprise responsable.'
    return null
  }
  requireSafeToReprovision(): void {
    const reason = this.blockReason()
    if (reason) throw new Error(reason)
  }
}

export const reprovisioningPreconditions = new SyncReprovisioningPreconditions()
