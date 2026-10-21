import { describe, expect, it } from 'vitest'
import type { SyncDiagnostics } from './synchronizationService'
import { synchronizationStatus } from './synchronizationStatus'

export const confirmedDiagnostics: SyncDiagnostics = {
  enabled: true,
  authentication: 'authorized',
  pendingEvents: 0,
  pending: 0,
  sending: 0,
  errors: 0,
  continuity: 'verified',
  backfillComplete: true,
  lastSuccessAt: 1792587000000,
  lastServerReceivedAt: '2026-10-21T12:32:00Z',
  lastExchangeAt: null,
  lastError: null,
  errorCategory: 'none',
}

describe('Présentation du suivi de synchronisation', () => {
  it.each([
    ['not_configured', 'Synchronisation non configurée'],
    ['not_enrolled', 'Tablette non enrôlée'],
    ['pending', 'Enrôlement en attente'],
    ['session_expired', 'Session de synchronisation expirée'],
    ['revoked', 'Tablette non autorisée'],
    ['authorization_denied', 'Tablette non autorisée'],
    ['needs_recovery', 'Intervention nécessaire'],
    ['server_unreachable', 'Connexion au service indisponible'],
    ['unknown_future_status', 'Suivi incomplet'],
    ['native_only', 'Mode Web — enregistrement local uniquement'],
  ])('distingue %s même avec un ancien reçu', (authentication, title) => {
    expect(synchronizationStatus({ ...confirmedDiagnostics, authentication }).title).toBe(title)
  })

  it('exige un reçu validé, la complétude et la continuité pour annoncer un succès', () => {
    expect(synchronizationStatus(confirmedDiagnostics).title).toBe('Synchronisation à jour')
    for (const patch of [
      { lastSuccessAt: null, lastServerReceivedAt: null },
      { lastServerReceivedAt: 'invalid' },
      { continuity: 'unknown' as const },
      { backfillComplete: false },
      { errors: 1, pendingEvents: 1 },
      { lastServerReceivedAt: null },
      { errorCategory: undefined },
      { pendingEvents: -1 },
      { pendingEvents: 0, pending: 1 },
      { enabled: undefined },
    ]) {
      expect(
        synchronizationStatus({ ...confirmedDiagnostics, ...patch } as SyncDiagnostics).title,
      ).not.toBe('Synchronisation à jour')
    }
  })

  it('ne confond pas un ancien reçu et les opérations actuelles', () => {
    expect(
      synchronizationStatus({ ...confirmedDiagnostics, pendingEvents: 5, pending: 5 }).title,
    ).toBe('5 opérations en attente d’envoi')
    const sending = synchronizationStatus({
      ...confirmedDiagnostics,
      pendingEvents: 5,
      pending: 3,
      sending: 2,
    })
    expect(sending.title).toBe('Synchronisation en cours')
    expect(sending.retry).toBe(false)
  })

  it.each([
    ['temporary', 'Envoi temporairement interrompu', true],
    ['service_unreachable', 'Connexion au service indisponible', true],
    ['authentication', 'Reconnexion nécessaire', false],
    ['conflict', 'Intervention nécessaire', false],
  ] as const)('traduit %s sans exposer les erreurs brutes', (errorCategory, title, retry) => {
    const view = synchronizationStatus({
      ...confirmedDiagnostics,
      pendingEvents: 1,
      errors: 1,
      errorCategory,
      lastError: 'SQL JWT token-secret',
    })
    expect(view.title).toBe(title)
    expect(view.retry).toBe(retry)
    expect(view.message).not.toMatch(/SQL|JWT|token-secret/)
    expect(view.message).toContain('restent enregistrées')
  })

  it('distingue désactivation, absence de preuve et lecture impossible', () => {
    expect(synchronizationStatus(null).title).toBe('Suivi non disponible')
    expect(synchronizationStatus({ ...confirmedDiagnostics, enabled: false }).title).toBe(
      'Synchronisation désactivée',
    )
    expect(
      synchronizationStatus({
        ...confirmedDiagnostics,
        lastSuccessAt: null,
        lastServerReceivedAt: null,
      }).title,
    ).toBe('Aucune synchronisation confirmée')
  })
})
