import {
  tabletAuth,
  type NativeTabletAuth,
  type TabletAuthorization,
  type TabletAuthorizationStatus,
} from '../native/tabletAuth'
import { supabaseConfiguration } from '../config/supabaseRuntime'
import { getResponsibleModeService } from './responsibleModeService'

export const tabletAuthorizationMessages: Record<TabletAuthorizationStatus, string> = {
  not_configured: 'Synchronisation non configurée',
  not_enrolled: 'Tablette non enrôlée',
  pending: 'Enrôlement en attente d’approbation serveur',
  authorized: 'Tablette autorisée pour la synchronisation',
  session_expired: 'Session expirée. Reconnectez cette tablette.',
  revoked: 'Tablette révoquée. Les ventes locales sont conservées.',
  needs_recovery: 'Vérification ou reprise nécessaire. Les échanges restent suspendus.',
  server_unreachable:
    'Serveur inaccessible. Les ventes et impressions locales restent disponibles.',
  authorization_denied:
    'Autorisation serveur refusée. Faites vérifier les droits par le responsable.',
  invitation_expired: 'Invitation expirée. Demandez une nouvelle approbation.',
  invitation_used: 'Invitation déjà consommée. Vérifiez l’autorisation.',
  invitation_invalid: 'Code d’invitation incorrect.',
  attempts_exceeded: 'Trop de tentatives. Une nouvelle demande d’enrôlement est nécessaire.',
  replacement_conflict: 'Une autre installation a été activée. Faites vérifier le remplacement.',
}

export class TabletEnrollmentService {
  constructor(
    private readonly native: NativeTabletAuth | null = tabletAuth.isAndroid()
      ? tabletAuth.bridge
      : null,
    private readonly configured: boolean = supabaseConfiguration.status === 'configured',
    private readonly requireResponsible: () => void = () =>
      getResponsibleModeService().requireUnlocked(),
  ) {}

  initialStatus(): TabletAuthorization {
    return { status: this.configured ? 'not_enrolled' : 'not_configured' }
  }

  async status(verify = false): Promise<TabletAuthorization> {
    if (!this.configured) return { status: 'not_configured' }
    if (!this.native) return { status: 'not_enrolled' }
    if (verify) this.requireResponsible()
    return this.native.getStatus({ verify })
  }

  async request(terminalId: string, reconnect = false): Promise<TabletAuthorization> {
    this.requireResponsible()
    return this.requiredNative().requestEnrollment({ terminalId, reconnect })
  }

  async activate(invitationCode: string): Promise<TabletAuthorization> {
    this.requireResponsible()
    if (!invitationCode.trim())
      throw new Error('Saisissez le code d’invitation remis par le responsable.')
    return this.requiredNative().activate({ invitationCode: invitationCode.trim() })
  }

  async manager(options: Parameters<NativeTabletAuth['managerOperation']>[0]) {
    this.requireResponsible()
    const result = await this.requiredNative().managerOperation(options)
    const succeeded =
      options.action === 'approve'
        ? result.status === 'pending' && Boolean(result.invitationCode)
        : result.status === 'revoked'
    if (!succeeded)
      throw new Error(
        'L’action serveur n’a pas été autorisée. Vérifiez le compte responsable, ses droits et sa connexion MFA si nécessaire. Les données locales sont conservées.',
      )
    return result
  }

  private requiredNative(): NativeTabletAuth {
    if (!this.configured)
      throw new Error('Configurez le projet Supabase dans la build avant l’enrôlement.')
    if (!this.native)
      throw new Error('L’enrôlement sécurisé est disponible dans l’application Android.')
    return this.native
  }
}

export const tabletEnrollmentService = new TabletEnrollmentService()
