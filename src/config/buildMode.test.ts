import { describe, expect, it } from 'vitest'
import { shouldEnableDevPanel } from './buildMode'

describe('configuration des modes de build', () => {
  it('active le panneau de développement pour le serveur Vite et android-test', () => {
    expect(shouldEnableDevPanel({ DEV: true, MODE: 'development' })).toBe(true)
    expect(shouldEnableDevPanel({ DEV: false, MODE: 'android-test' })).toBe(true)
  })

  it('refuse toujours le panneau de développement en production', () => {
    expect(
      shouldEnableDevPanel({
        DEV: false,
        MODE: 'production',
        VITE_ENABLE_DEV_PANEL: 'true',
      }),
    ).toBe(false)
  })
})
