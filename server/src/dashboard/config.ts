import { defaultPeriod, festivalDays, timeZone } from './periods.ts'
import type { Scope } from '../persistence/model.ts'
import type { DashboardSettings } from './types.ts'
export type DashboardConfig = {
  port: number
  host: string
  publicOrigin?: string
  scope: Scope
  settings: DashboardSettings
}

export function dashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const organizationId = env.DASHBOARD_ORGANIZATION_ID ?? '',
    festivalId = env.DASHBOARD_FESTIVAL_ID ?? ''
  if (!uuid.test(organizationId) || !uuid.test(festivalId))
    throw new Error(
      'DASHBOARD_ORGANIZATION_ID et DASHBOARD_FESTIVAL_ID doivent être des UUID valides.',
    )
  const start = env.DASHBOARD_FESTIVAL_START_DATE ?? '',
    days = festivalDays(start)
  const number = (key: string, fallback: number, minimum: number, maximum: number) => {
    const value = env[key] ?? String(fallback)
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < minimum ||
      Number(value) > maximum
    )
      throw new Error(`Configuration invalide : ${key}`)
    return Number(value)
  }
  const goal = (key: string) => (env[key] ? number(key, 0, 1, 1_000_000_000) : null)
  const common = {
    scope: { organizationId, festivalId },
    settings: {
      days,
      defaultPeriod: defaultPeriod(start),
      refreshSeconds: number('DASHBOARD_REFRESH_SECONDS', 60, 15, 3600),
      staleMinutes: number('DASHBOARD_STALE_MINUTES', 10, 1, 10080),
      goals: {
        daily: goal('DASHBOARD_DAILY_GOAL_CENTS'),
        festival: goal('DASHBOARD_FESTIVAL_GOAL_CENTS'),
      },
      timeZone,
    },
  }
  const rawPort = env.DASHBOARD_PORT ?? '4310'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535)
    throw new Error('DASHBOARD_PORT invalide.')
  const mode = env.DASHBOARD_PUBLIC ?? 'false'
  if (!['true', 'false'].includes(mode)) throw new Error('DASHBOARD_PUBLIC invalide.')
  if (mode === 'false') {
    if (env.DASHBOARD_PUBLIC_ORIGIN)
      throw new Error('DASHBOARD_PUBLIC=true requis pour une origine publique.')
    return { ...common, port: Number(rawPort), host: '127.0.0.1' }
  }
  let origin: URL
  try {
    origin = new URL(env.DASHBOARD_PUBLIC_ORIGIN ?? '')
  } catch {
    throw new Error('DASHBOARD_PUBLIC_ORIGIN doit être une origine HTTPS.')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !origin.hostname.includes('.') ||
    origin.hostname === '127.0.0.1'
  )
    throw new Error('DASHBOARD_PUBLIC_ORIGIN doit être une origine HTTPS.')
  return { ...common, port: Number(rawPort), host: '0.0.0.0', publicOrigin: origin.origin }
}
