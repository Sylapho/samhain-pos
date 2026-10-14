export type SupabaseConfiguration =
  | { status: 'not_configured' }
  | { status: 'invalid'; reason: 'partial' | 'url' | 'key' | 'environment' | 'production_project' }
  | {
      status: 'configured'
      environment: 'test' | 'production'
      url: string
      publishableKey: string
    }

export type SupabaseBuildEnvironment = {
  VITE_ENABLE_DEV_PANEL?: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
  VITE_SUPABASE_ENVIRONMENT?: string
  SAMHAIN_SUPABASE_PRODUCTION_URL?: string
}

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      /[\\\s]/.test(value)
    )
      return null
    return url.origin
  } catch {
    return null
  }
}

// Only the validated result may enter the bundle or native assets. Never include raw values in errors.
export function resolveSupabaseConfiguration(
  mode: string,
  environment: SupabaseBuildEnvironment,
): SupabaseConfiguration {
  const url = environment.VITE_SUPABASE_URL?.trim() ?? ''
  const key = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  const target = environment.VITE_SUPABASE_ENVIRONMENT?.trim() ?? ''
  if (!url && !key && !target) return { status: 'not_configured' }
  if (!url || !key || !target) return { status: 'invalid', reason: 'partial' }
  const origin = httpsOrigin(url)
  if (!origin) return { status: 'invalid', reason: 'url' }
  // New publishable keys only: legacy JWTs, service_role, secrets and session tokens are refused.
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return { status: 'invalid', reason: 'key' }
  const expectedTarget = mode === 'production' ? 'production' : 'test'
  if (target !== expectedTarget) return { status: 'invalid', reason: 'environment' }
  const productionOrigin = httpsOrigin(environment.SAMHAIN_SUPABASE_PRODUCTION_URL?.trim() ?? '')
  if (
    (mode === 'production' && origin !== productionOrigin) ||
    (mode !== 'production' && origin === productionOrigin)
  )
    return { status: 'invalid', reason: 'production_project' }
  return { status: 'configured', environment: expectedTarget, url: origin, publishableKey: key }
}

export function supabaseConfigurationMessage(configuration: SupabaseConfiguration): string {
  if (configuration.status === 'not_configured') return 'Synchronisation non configurée'
  if (configuration.status === 'configured') {
    return 'Configuration de synchronisation prête — service non encore activé'
  }
  const reasons: Record<Extract<SupabaseConfiguration, { status: 'invalid' }>['reason'], string> = {
    partial: 'configuration incomplète',
    url: 'URL HTTPS invalide',
    key: 'clé publique invalide',
    environment: 'environnement incompatible avec cette version',
    production_project: 'projet de production non confirmé ou utilisé en test',
  }
  return `Synchronisation désactivée : ${reasons[configuration.reason]}. Faites corriger la configuration de cette version.`
}
