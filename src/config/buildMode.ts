export type BuildEnvironment = {
  DEV: boolean
  MODE: string
  VITE_ENABLE_DEV_PANEL?: string
}

export function shouldEnableDevPanel(environment: BuildEnvironment): boolean {
  if (environment.MODE === 'production') return false

  return (
    environment.DEV ||
    environment.MODE === 'android-test' ||
    environment.VITE_ENABLE_DEV_PANEL === 'true'
  )
}
