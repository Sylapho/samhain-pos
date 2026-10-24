import type { ClientSession, Db } from 'mongodb'
import type { ChainScope, Scope, Subject, Capability, Chain } from '../persistence/model.ts'
import type { AuthInstallation, AuthSession } from './types.ts'
import type { SessionClaims } from './crypto.ts'
import { reject } from './crypto.ts'

export const scopeOf = (value: Scope): Scope => ({
  organizationId: value.organizationId,
  festivalId: value.festivalId,
})
export const chainOf = (value: ChainScope): ChainScope => ({
  ...scopeOf(value),
  chainId: value.chainId,
})
export async function scopeGuard(db: Db, scope: Scope, session: ClientSession) {
  for (const [collection, filter] of [
    ['organizations', { organizationId: scope.organizationId, active: true }],
    ['festivals', { ...scopeOf(scope), active: true }],
  ] as const)
    if (
      (await db.collection(collection).updateOne(filter, { $inc: { fence: 1 } }, { session }))
        .matchedCount !== 1
    )
      reject('SCOPE_DENIED', 403)
}
export async function managerGuard(
  db: Db,
  scope: Scope,
  actor: Subject,
  capability: Capability,
  session: ClientSession,
) {
  await scopeGuard(db, scope, session)
  if (
    (
      await db.collection('scopeGrants').updateOne(
        {
          ...scopeOf(scope),
          issuer: actor.issuer,
          subject: actor.subject,
          capability,
          active: true,
        },
        { $inc: { fence: 1 } },
        { session },
      )
    ).matchedCount !== 1
  )
    reject('SCOPE_DENIED', 403)
}
export async function installationGuard(db: Db, id: string, session: ClientSession) {
  await db
    .collection('authorizationGuards')
    .updateOne(
      { guardId: `installation:${id}` },
      { $inc: { fence: 1 }, $setOnInsert: { documentSchemaVersion: 1 } },
      { upsert: true, session },
    )
}
export async function tabletGuard(
  db: Db,
  claims: SessionClaims,
  session: ClientSession,
  allowRecovery = false,
) {
  const scope = chainOf(claims)
  await scopeGuard(db, scope, session)
  const installation = await db.collection<AuthInstallation>('installations').findOneAndUpdate(
    {
      ...scope,
      installationId: claims.sub!,
      enrollmentGeneration: claims.enrollmentGeneration,
      active: true,
      authVersion: 1,
    },
    { $inc: { fence: 1 } },
    { session, returnDocument: 'after' },
  )
  if (
    !installation ||
    (!allowRecovery && installation.authorization !== 'authorized') ||
    installation.authorization === 'revoked'
  )
    reject('ACCESS_REVOKED', 403)
  const apiSession = await db.collection<AuthSession>('apiSessions').findOneAndUpdate(
    {
      ...scope,
      installationId: claims.sub!,
      sessionId: claims.sid,
      enrollmentGeneration: claims.enrollmentGeneration,
      active: true,
      authVersion: 1,
      $expr: {
        $and: [{ $gt: ['$expiresAt', '$$NOW'] }, { $gt: ['$absoluteExpiresAt', '$$NOW'] }],
      },
    },
    { $inc: { fence: 1 } },
    { session, returnDocument: 'after' },
  )
  if (!apiSession || apiSession.issuer !== claims.iss || apiSession.subject !== claims.sub)
    reject('AUTH_REQUIRED')
  const chain = await db
    .collection<Chain>('chains')
    .findOneAndUpdate(
      { ...scope, enrollmentGeneration: claims.enrollmentGeneration },
      { $inc: { fence: 1 } },
      { session, returnDocument: 'after' },
    )
  if (!chain) reject('ACCESS_REVOKED', 403)
  return { installation: installation!, apiSession: apiSession!, chain: chain! }
}
