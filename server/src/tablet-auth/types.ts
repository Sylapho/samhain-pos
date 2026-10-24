import type {
  ApiSession,
  EnrollmentRequest,
  Installation,
  RefreshRotation,
} from '../persistence/model.ts'
export type PrefixTuple = { sequence: number; eventId: string; hash: string; terminalId: string }
export type Dossier = {
  chainId: string
  restored: boolean
  terminalId: string
  prefix: PrefixTuple[]
  legacyOrderIds: string[]
}
export type AuthEnrollment = EnrollmentRequest & {
  authVersion: 1
  operationRequestId: string
  requestFingerprint: string
  decisionOperationId?: string
  decisionFingerprint?: string
  expectedGeneration?: number
  expectedInstallationId?: string | null
  activationOperationId?: string
  activationFingerprint?: string
  activationResponseCiphertext?: string
  responseExpiresAt?: Date
}
export type AuthInstallation = Installation & { authVersion: 1; revokedAt?: Date }
export type AuthSession = ApiSession & { authVersion: 1; keyFingerprint: string }
export type Rotation = RefreshRotation & { authVersion: 1 }
export type Proof = { nonce: string; signature: string; raw: Buffer }
export type SessionReply = {
  access_token: string
  refresh_token: string
  expires_at: number
  expires_in: number
  token_type: 'bearer'
}
