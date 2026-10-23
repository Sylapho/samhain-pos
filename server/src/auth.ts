import type { FastifyRequest } from 'fastify'
import { ApiError } from './errors.ts'

export type Capability = 'manage_enrollment' | 'read_ledger' | 'publish_catalog'
export type Scope = Readonly<{ organizationId: string; festivalId: string }>
export type Principal =
  | Readonly<{
      kind: 'tablet'
      installationId: string
      chainId: string
      generation: number
      scope: Scope
    }>
  | Readonly<{
      kind: 'manager'
      subject: string
      grants: readonly Readonly<{ scope: Scope; capability: Capability }>[]
    }>
export type AccessPolicy =
  | { kind: 'tablet'; scope: Scope; chainId: string }
  | { kind: 'manager'; scope: Scope; capability: Capability }

// Only a server-owned verifier may create a Principal. #132 supplies registry/session/proof checks.
export type Authenticator = (request: FastifyRequest) => Promise<Principal | null>
export const denyAuthentication: Authenticator = async () => null

export function authorize(principal: Principal | null, policy: AccessPolicy): void {
  if (!principal) throw new ApiError(401, 'AUTH_REQUIRED')
  const sameScope = (scope: Scope) =>
    scope.organizationId === policy.scope.organizationId &&
    scope.festivalId === policy.scope.festivalId
  const allowed =
    policy.kind === 'tablet'
      ? principal.kind === 'tablet' &&
        sameScope(principal.scope) &&
        principal.chainId === policy.chainId
      : principal.kind === 'manager' &&
        principal.grants.some(
          (grant) => sameScope(grant.scope) && grant.capability === policy.capability,
        )
  if (!allowed) throw new ApiError(403, 'SCOPE_DENIED')
}
