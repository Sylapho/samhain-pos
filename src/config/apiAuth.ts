export type ApiAuthConfiguration =
  | { status: 'not_configured' | 'invalid' }
  | {
      status: 'configured'
      environment: 'test' | 'production'
      origin: string
      destinationId: string
    }
export type ApiAuthBuildEnvironment = {
  VITE_SAMHAIN_API_URL?: string
  VITE_SAMHAIN_API_ENVIRONMENT?: string
  VITE_SAMHAIN_API_DESTINATION_ID?: string
  SAMHAIN_API_PRODUCTION_URL?: string
  SAMHAIN_API_PRODUCTION_DESTINATION_ID?: string
}
export function resolveApiAuthConfiguration(
  mode: string,
  env: ApiAuthBuildEnvironment,
): ApiAuthConfiguration {
  const origin = env.VITE_SAMHAIN_API_URL?.trim() ?? ''
  const environment = env.VITE_SAMHAIN_API_ENVIRONMENT?.trim() ?? ''
  const destinationId = env.VITE_SAMHAIN_API_DESTINATION_ID?.trim() ?? ''
  if (!origin && !environment && !destinationId) return { status: 'not_configured' }
  try {
    const parsed = new URL(origin)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/' ||
      /[\\\s]/.test(origin) ||
      !['test', 'production'].includes(environment) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(destinationId)
    )
      return { status: 'invalid' }
    if (environment !== (mode === 'production' ? 'production' : 'test'))
      return { status: 'invalid' }
    if (
      mode === 'production' &&
      (env.SAMHAIN_API_PRODUCTION_URL?.replace(/\/$/, '') !== parsed.origin ||
        env.SAMHAIN_API_PRODUCTION_DESTINATION_ID !== destinationId)
    )
      return { status: 'invalid' }
    return {
      status: 'configured',
      environment: environment as 'test' | 'production',
      origin: parsed.origin,
      destinationId,
    }
  } catch {
    return { status: 'invalid' }
  }
}
