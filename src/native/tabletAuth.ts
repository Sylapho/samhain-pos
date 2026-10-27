import { Capacitor, registerPlugin } from '@capacitor/core'

export type TabletAuthorizationStatus =
  | 'not_configured'
  | 'not_enrolled'
  | 'pending'
  | 'rejected'
  | 'oidc_not_configured'
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
  enrollmentPrepared?: boolean
  requestedScope?: { organizationId: string; festivalId: string }
  checkedAt?: string
}

export interface NativeTabletAuth {
  inspectEnrollment(options: {
    requestId: string
    organizationId: string
    festivalId: string
  }): Promise<{
    requestId: string
    installationId: string
    chainId: string
    terminalId: string
    restored: boolean
    prefixCount: number
    legacyCount: number
  }>
  getStatus(options: { verify: boolean }): Promise<TabletAuthorization>
  requestEnrollment(options: {
    terminalId: string
    organizationId: string
    festivalId: string
    reconnect: boolean
  }): Promise<TabletAuthorization>
  activate(options: { invitationCode: string }): Promise<TabletAuthorization>
  prepareReplacement(): Promise<TabletAuthorization>
  managerLogin(): Promise<{ status: 'authenticated' | TabletAuthorizationStatus }>
  managerStatus(): Promise<{ authenticated: boolean }>
  managerLogout(): Promise<void>
  managerOperation(options: {
    action: 'approve' | 'reject' | 'revoke'
    body: {
      requestId?: string
      organizationId?: string
      festivalId?: string
      chainId: string
      installationId?: string
      replacesInstallationId?: string
    }
  }): Promise<TabletAuthorization>
}

const plugin = registerPlugin<NativeTabletAuth>('TabletAuth')
export const tabletAuth = {
  isAndroid: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  bridge: plugin,
}
