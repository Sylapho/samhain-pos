import type { SyncDiagnostics } from './synchronizationService'

const localSafety =
  'Les opérations restent enregistrées sur cette tablette. Les ventes et impressions peuvent continuer sans connexion.'
const configure = 'Ouvrez les paramètres de synchronisation de cette tablette.'

export function synchronizationStatus(state: SyncDiagnostics | null) {
  const view = (title: string, message: string, retry = false, settings = false) => ({
    title,
    message,
    retry: retry && state?.sending === 0,
    settings,
  })
  if (!state)
    return view(
      'Suivi non disponible',
      'Impossible de lire les informations. Réessayez l’actualisation. ' + localSafety,
    )
  if (state.authentication === 'native_only')
    return view(
      'Mode Web — enregistrement local uniquement',
      'Les compteurs concernent ce navigateur. Les échanges sécurisés avec le service sont disponibles dans l’application Android.',
    )
  if (state.authentication === 'not_configured')
    return view(
      'Synchronisation non configurée',
      'La configuration du service doit être ajoutée à l’application. ' + localSafety,
      false,
      true,
    )
  if (state.authentication === 'not_enrolled')
    return view('Tablette non enrôlée', configure + ' ' + localSafety, false, true)
  if (state.authentication === 'pending')
    return view(
      'Enrôlement en attente',
      'Faites approuver la demande puis activez la tablette dans les paramètres. ' + localSafety,
      false,
      true,
    )
  if (['revoked', 'authorization_denied', 'attempts_exceeded'].includes(state.authentication))
    return view(
      'Tablette non autorisée',
      'L’autorisation de cette tablette doit être vérifiée par un responsable du service. ' +
        localSafety,
      false,
      true,
    )
  if (state.authentication === 'session_expired')
    return view(
      'Session de synchronisation expirée',
      'Cette tablette doit être reconnectée au service dans les paramètres. ' + localSafety,
      false,
      true,
    )
  if (
    state.authentication === 'needs_recovery' ||
    state.errorCategory === 'conflict' ||
    state.continuity === 'failed'
  )
    return view(
      'Intervention nécessaire',
      'Certaines opérations nécessitent une vérification par un responsable. Ne réinitialisez pas la tablette. ' +
        localSafety,
      false,
      true,
    )
  if (
    state.authentication === 'server_unreachable' ||
    state.errorCategory === 'service_unreachable'
  )
    return view(
      'Connexion au service indisponible',
      'Vérifiez la connexion. Les opérations seront envoyées dès que possible. ' + localSafety,
      state.enabled,
    )
  if (state.authentication !== 'authorized')
    return view(
      'Suivi incomplet',
      'L’autorisation de la tablette ne peut pas être vérifiée. ' + configure + ' ' + localSafety,
      false,
      true,
    )
  if (
    typeof state.enabled !== 'boolean' ||
    typeof state.backfillComplete !== 'boolean' ||
    !['verified', 'unknown', 'failed'].includes(state.continuity) ||
    !['none', 'temporary', 'authentication', 'conflict', 'service_unreachable'].includes(
      state.errorCategory,
    ) ||
    ![state.pendingEvents, state.pending, state.sending, state.errors].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    state.pending + state.sending > state.pendingEvents ||
    state.errors > state.pendingEvents
  )
    return view(
      'Suivi incomplet',
      'Les compteurs ne peuvent pas être vérifiés. Actualisez le suivi. ' + localSafety,
    )
  if (!state.enabled)
    return view(
      'Synchronisation désactivée',
      'Réactivez les échanges pour reprendre l’envoi. ' + localSafety,
    )
  if (state.errorCategory === 'authentication')
    return view('Reconnexion nécessaire', configure + ' ' + localSafety, false, true)
  if (state.sending > 0)
    return view(
      'Synchronisation en cours',
      'L’envoi est en cours. La réception par le serveur reste à confirmer. ' + localSafety,
    )
  if (state.errorCategory === 'temporary' || state.errors > 0)
    return view(
      'Envoi temporairement interrompu',
      'L’envoi n’a pas abouti. Une nouvelle tentative sera effectuée automatiquement. ' +
        localSafety,
      true,
    )
  if (!state.backfillComplete)
    return view(
      'Vérification des opérations en cours',
      'Le décompte est provisoire pendant la vérification des opérations enregistrées. ' +
        localSafety,
      true,
    )
  if (state.pendingEvents > 0)
    return view(
      `${state.pendingEvents} opération${state.pendingEvents > 1 ? 's' : ''} en attente d’envoi`,
      'L’envoi reprendra automatiquement lorsque le service sera accessible. ' + localSafety,
      true,
    )
  if (
    state.continuity === 'verified' &&
    state.lastSuccessAt !== null &&
    Number.isFinite(state.lastSuccessAt) &&
    state.lastServerReceivedAt &&
    Number.isFinite(Date.parse(state.lastServerReceivedAt))
  )
    return view(
      'Synchronisation à jour',
      'Toutes les opérations enregistrées ont une réception confirmée par le serveur.',
    )
  return view(
    'Aucune synchronisation confirmée',
    'Aucune réception serveur ne permet de confirmer que les données sont à jour. ' + localSafety,
    true,
  )
}
