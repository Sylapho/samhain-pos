import { describe, expect, it } from 'vitest'
import { resolveSupabaseConfiguration, supabaseConfigurationMessage } from './supabase'

const testEnvironment = {
  VITE_SUPABASE_URL: 'https://test.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
  VITE_SUPABASE_ENVIRONMENT: 'test',
  SAMHAIN_SUPABASE_PRODUCTION_URL: 'https://production.supabase.co',
}

describe('configuration Supabase optionnelle', () => {
  it.each(['development', 'android-test', 'production'])(
    'désactive sans configuration en %s',
    (mode) => {
      expect(resolveSupabaseConfiguration(mode, {})).toEqual({ status: 'not_configured' })
    },
  )

  it.each(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ENVIRONMENT'])(
    'refuse le champ manquant %s',
    (field) => {
      expect(
        resolveSupabaseConfiguration('android-test', { ...testEnvironment, [field]: '' }),
      ).toEqual({ status: 'invalid', reason: 'partial' })
    },
  )

  it.each([
    'http://test.supabase.co',
    'not a url',
    'https://user:password@test.supabase.co',
    'https://test.supabase.co/path',
    'https://test.supabase.co?token=secret',
    'https://test.supabase.co#secret',
    'https://test.supabase.co\\path',
  ])('refuse une URL non sûre %s', (url) => {
    expect(
      resolveSupabaseConfiguration('android-test', { ...testEnvironment, VITE_SUPABASE_URL: url }),
    ).toEqual({ status: 'invalid', reason: 'url' })
  })

  it.each([
    'sb_secret_fixture',
    'eyJheader.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature',
    'sb_publishable_',
    'private-token',
  ])('élimine tout credential non publiable %s', (key) => {
    const result = resolveSupabaseConfiguration('android-test', {
      ...testEnvironment,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    })
    expect(result).toEqual({ status: 'invalid', reason: 'key' })
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it('sépare explicitement test et production sans fallback', () => {
    expect(resolveSupabaseConfiguration('android-test', testEnvironment).status).toBe('configured')
    expect(resolveSupabaseConfiguration('production', testEnvironment)).toEqual({
      status: 'invalid',
      reason: 'environment',
    })
    const production = {
      ...testEnvironment,
      VITE_SUPABASE_ENVIRONMENT: 'production',
      VITE_SUPABASE_URL: 'https://production.supabase.co/',
    }
    expect(resolveSupabaseConfiguration('production', production)).toEqual({
      status: 'configured',
      environment: 'production',
      url: 'https://production.supabase.co',
      publishableKey: 'sb_publishable_fixture',
    })
    expect(
      resolveSupabaseConfiguration('production', {
        ...production,
        SAMHAIN_SUPABASE_PRODUCTION_URL: '',
      }),
    ).toEqual({ status: 'invalid', reason: 'production_project' })
    expect(
      resolveSupabaseConfiguration('production', {
        ...production,
        VITE_SUPABASE_URL: testEnvironment.VITE_SUPABASE_URL,
      }),
    ).toEqual({ status: 'invalid', reason: 'production_project' })
    expect(
      resolveSupabaseConfiguration('android-test', {
        ...testEnvironment,
        VITE_SUPABASE_URL: production.VITE_SUPABASE_URL,
      }),
    ).toEqual({ status: 'invalid', reason: 'production_project' })
  })

  it('affiche un statut responsable expurgé sans prétendre synchroniser', () => {
    expect(supabaseConfigurationMessage({ status: 'not_configured' })).toBe(
      'Synchronisation non configurée',
    )
    expect(supabaseConfigurationMessage({ status: 'invalid', reason: 'partial' })).toContain(
      'configuration incomplète',
    )
    expect(
      supabaseConfigurationMessage(resolveSupabaseConfiguration('android-test', testEnvironment)),
    ).toContain('service non encore activé')
  })
})
