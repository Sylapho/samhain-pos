import { describe, expect, it } from 'vitest'
import { resolveApiAuthConfiguration } from './apiAuth'
import {
  containsPrivilegedCredential,
  supabaseBuildConfiguration,
} from '../../scripts/supabase-build'

const destinationId = '12345678-1234-4234-8234-123456789abc'
const environment = {
  VITE_SAMHAIN_API_URL: 'https://api.example.invalid',
  VITE_SAMHAIN_API_ENVIRONMENT: 'test',
  VITE_SAMHAIN_API_DESTINATION_ID: destinationId,
}
describe('configuration publique de la destination API', () => {
  it('reste désactivée sans configuration et refuse une configuration partielle', () => {
    expect(resolveApiAuthConfiguration('test', {})).toEqual({ status: 'not_configured' })
    expect(
      resolveApiAuthConfiguration('test', {
        VITE_SAMHAIN_API_URL: environment.VITE_SAMHAIN_API_URL,
      }),
    ).toEqual({ status: 'invalid' })
  })
  it('n’expose que l’origine HTTPS et l’identité de destination confirmée', () => {
    expect(resolveApiAuthConfiguration('test', environment)).toEqual({
      status: 'configured',
      origin: environment.VITE_SAMHAIN_API_URL,
      environment: 'test',
      destinationId,
    })
    for (const origin of [
      'http://api.example.invalid',
      'https://user:password@api.example.invalid',
      'https://api.example.invalid/path',
      'https://api.example.invalid?secret=x',
      'mongodb://api.example.invalid',
      'https://api.example.invalid/#fragment',
    ])
      expect(
        resolveApiAuthConfiguration('test', { ...environment, VITE_SAMHAIN_API_URL: origin })
          .status,
      ).toBe('invalid')
  })
  it('requiert les deux confirmations indépendantes pour une release', () => {
    const production = { ...environment, VITE_SAMHAIN_API_ENVIRONMENT: 'production' }
    expect(() => supabaseBuildConfiguration('production', production)).toThrow(/non confirmée/)
    expect(
      resolveApiAuthConfiguration('production', {
        ...production,
        SAMHAIN_API_PRODUCTION_URL: environment.VITE_SAMHAIN_API_URL,
        SAMHAIN_API_PRODUCTION_DESTINATION_ID: destinationId,
      }).status,
    ).toBe('configured')
  })
  it('refuse les URI MongoDB, clés privées et sessions dans les artefacts', () => {
    expect(containsPrivilegedCredential('mongodb+srv://test-only.invalid')).toBe(true)
    expect(containsPrivilegedCredential('-----BEGIN PRIVATE KEY-----')).toBe(true)
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'test-only', exp: 1 })).toString('base64url')}.test`
    expect(containsPrivilegedCredential(jwt)).toBe(true)
  })
})
