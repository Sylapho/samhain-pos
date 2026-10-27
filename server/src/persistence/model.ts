// Document versions are independent of samhain-sync/1 and financial schemaVersion.
export type Versioned = { documentSchemaVersion: 1 }
export type Scope = { organizationId: string; festivalId: string }
export type ChainScope = Scope & { chainId: string }
export type Subject = { issuer: string; subject: string }
export type Capability = 'manage_enrollment' | 'read_ledger' | 'publish_catalog'
export type Head = { sequence: number; hash: string | null }
export type Organization = Versioned & { organizationId: string; active: boolean; fence: number }
export type Festival = Versioned & Scope & { active: boolean; fence: number }
export type ScopeGrant = Versioned &
  Scope &
  Subject & { capability: Capability; active: boolean; fence: number }
export type AuthorizationGuard = Versioned & { guardId: string; fence: number }
export type Chain = Versioned &
  ChainScope & { enrollmentGeneration: number; head: Head; fence: number }
export type Installation = Versioned &
  ChainScope &
  Subject & {
    installationId: string
    enrollmentGeneration: number
    active: boolean
    authorization: 'authorized' | 'needs_recovery' | 'revoked'
    fence: number
  }
export type InstallationKey = Versioned & {
  installationId: string
  enrollmentGeneration: number
  publicKeySpki: string
  keyFingerprint: string
  createdAt: Date
}
export type EnrollmentRequest = Versioned & {
  requestId: string
  installationId: string
  publicKeySpki: string
  dossierCanonical: string
  status: 'pending' | 'approved' | 'rejected' | 'activated'
  expiresAt: Date
  createdAt: Date
  approvedScope?: ChainScope & { replacesInstallationId?: string }
  requestedScope?: Scope
  approvedBy?: Subject
  approvedAt?: Date
  invitationHash?: string
  invitationExpiresAt?: Date
  attempts: number
}
export type TerminalRange = Versioned &
  ChainScope & {
    firstSequence: number
    lastSequence: number | null
    sourceTerminalId: string
    evidenceReference: string
  }
export type LedgerKind =
  'sale' | 'correction' | 'closure' | 'cash_session_opened' | 'cash_float_updated'
export type LedgerEvent = Versioned &
  ChainScope & {
    eventId: string
    kind: LedgerKind
    sequence: number
    hash: string
    previousHash: string | null
    ledgerSchemaVersion: 1
    protocolVersion: 1
    ledgerCanonicalization: 'ts-ledger-v1' | 'android-ledger-v1'
    payloadCanonical: string
    transportFingerprint: string
    sourceTerminalId: string
    recordedAt: string
    serverReceivedAt: Date
    orderId?: string
    operationId?: string
    sessionId?: string
    referencedSessionId?: string
    originalOrderId?: string
    originalSaleHash?: string | null
  }
export type Sale = Versioned &
  ChainScope & { orderId: string } & (
    | { type: 'sealed'; ledgerEventId: string; saleHash: string }
    | {
        type: 'legacy'
        payloadCanonical: string
        transportFingerprint: string
        protocolVersion: 1
        sourceTerminalId: string
      }
  )
export type SyncReceipt = Versioned &
  ChainScope & {
    eventType: 'ledger' | 'legacy_order'
    eventId: string
    receiptId: string
    serverReceivedAt: Date
    sequence: number | null
    hash: string | null
    transportFingerprint: string
    installationId: string
    enrollmentGeneration: number
    issuer: string
    subject: string
    firstRequestId: string
  }
export type CatalogVersion = Versioned &
  Scope & {
    versionId: string
    revision: number
    schemaVersion: 1
    payload: string
    sha256: string
    publishedAt: Date
    author: Subject
  }
export type CatalogHead = Versioned &
  Scope & { revision: number; versionId: string | null; sha256: string | null }
export type ApiSession = Versioned &
  ChainScope &
  Subject & {
    sessionId: string
    installationId: string
    enrollmentGeneration: number
    refreshHash: string
    familyId: string
    active: boolean
    expiresAt: Date
    absoluteExpiresAt: Date
    fence: number
  }
export type RefreshRotation = Versioned & {
  sessionId: string
  rotationId: string
  previousRefreshHash: string
  proofHash: string
  responseCiphertext: string
  expiresAt: Date
}
export type SessionChallenge = Versioned &
  ChainScope &
  Subject & {
    purpose: 'session'
    nonceHash: string
    installationId: string
    enrollmentGeneration: number
    sessionId: string
    keyFingerprint: string
    action:
      | 'ledger-ingest-v1'
      | 'legacy-import-v1'
      | 'ledger-prefix-v1'
      | 'catalog-v1'
      | 'status'
      | 'refresh'
      | 'authorize'
    expiresAt: Date
    consumedAt: Date | null
  }
export type EnrollmentChallenge = Versioned &
  Subject & {
    purpose: 'enrollment'
    installationId: string
    keyFingerprint: string
    nonceHash: string
    expiresAt: Date
    consumedAt: Date | null
  } & (
    | { action: 'request'; requestId?: never }
    | { action: 'activate' | 'status' | 'authorize'; requestId: string }
  )
export type AuthChallenge = SessionChallenge | EnrollmentChallenge
export type AdministrationAudit = Versioned &
  Scope &
  Subject & {
    auditId: string
    action: string
    idempotencyKey: string
    requestFingerprint: string
    targetId: string
    outcome: string
    at: Date
  }
export type SchemaMigration = Versioned & { version: number; checksum: string; appliedAt: Date }
export type Documents = {
  organizations: Organization
  festivals: Festival
  scopeGrants: ScopeGrant
  authorizationGuards: AuthorizationGuard
  installations: Installation
  installationKeys: InstallationKey
  enrollmentRequests: EnrollmentRequest
  terminalRanges: TerminalRange
  chains: Chain
  ledgerEvents: LedgerEvent
  sales: Sale
  syncReceipts: SyncReceipt
  catalogVersions: CatalogVersion
  catalogHeads: CatalogHead
  apiSessions: ApiSession
  refreshRotations: RefreshRotation
  authChallenges: AuthChallenge
  administrationAudit: AdministrationAudit
  schemaMigrations: SchemaMigration
}
