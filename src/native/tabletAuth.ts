import { Capacitor, registerPlugin } from '@capacitor/core'

export type TabletAuthorizationStatus =
  | 'not_configured'
  | 'not_enrolled'
  | 'pending'
  | 'authorized'
  | 'session_expired'
  | 'revoked'
  | 'needs_recovery'
  | 'server_unreachable'
  | 'authorization_denied'
  | 'invitation_expired'
  | 'invitation_used'
  | 'invitation_invalid'
  | 'attempts_exceeded'
  | 'replacement_conflict'

export type TabletAuthorization = {
  status: TabletAuthorizationStatus
  installationId?: string
  requestId?: string
  chainId?: string
  organizationId?: string
  festivalId?: string
  enrollmentGeneration?: number
  serverHead?: { sequence: number; hash: string | null }
  prepared?: boolean
}

export interface NativeTabletAuth {
  getStatus(options: { verify: boolean }): Promise<TabletAuthorization>
  requestEnrollment(options: {
    terminalId: string
    reconnect: boolean
  }): Promise<TabletAuthorization>
  activate(options: { invitationCode: string }): Promise<TabletAuthorization>
  prepareReplacement(): Promise<TabletAuthorization>
  managerOperation(options: {
    action: 'approve' | 'revoke'
    email: string
    password: string
    body: {
      requestId?: string
      organizationId?: string
      festivalId?: string
      chainId: string
      installationId?: string
      replacesInstallationId?: string
    }
  }): Promise<TabletAuthorization & { invitationCode?: string }>
}

const plugin = registerPlugin<NativeTabletAuth>('TabletAuth')
export const tabletAuth = {
  isAndroid: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  bridge: plugin,
}
