export type DashboardConfig = { port: number; host: string; publicOrigin?: string }

export function dashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const rawPort = env.DASHBOARD_PORT ?? '4310'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535)
    throw new Error('DASHBOARD_PORT invalide.')
  const mode = env.DASHBOARD_PUBLIC ?? 'false'
  if (!['true', 'false'].includes(mode)) throw new Error('DASHBOARD_PUBLIC invalide.')
  if (mode === 'false') {
    if (env.DASHBOARD_PUBLIC_ORIGIN)
      throw new Error('DASHBOARD_PUBLIC=true requis pour une origine publique.')
    return { port: Number(rawPort), host: '127.0.0.1' }
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
  return { port: Number(rawPort), host: '0.0.0.0', publicOrigin: origin.origin }
}
