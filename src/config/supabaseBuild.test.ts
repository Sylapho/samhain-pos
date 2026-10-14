// @vitest-environment node
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  containsPrivilegedCredential,
  supabaseBuildConfiguration,
} from '../../scripts/supabase-build'
import type { SupabaseBuildEnvironment } from './supabase'

async function compile(
  mode: string,
  environment: SupabaseBuildEnvironment,
  code = 'console.log(import.meta.env, __SUPABASE_CONFIGURATION__)',
) {
  const config = supabaseBuildConfiguration(mode, environment)
  const result = await build({
    configFile: false,
    envDir: false,
    mode,
    logLevel: 'silent',
    ...config,
    plugins: [
      ...config.plugins,
      {
        name: 'fixture',
        resolveId: (id) => (id === 'fixture' ? '\0fixture' : undefined),
        load: (id) => (id === '\0fixture' ? code : undefined),
      },
    ],
    build: { write: false, rollupOptions: { input: 'fixture' } },
  })
  if (!('output' in result)) throw new Error('Expected one build')
  return result.output
    .map((item) => (item.type === 'chunk' ? item.code : String(item.source)))
    .join('\n')
}

describe('ressources Supabase compilées', () => {
  it('ne publie pas les variables brutes, même avec import.meta.env entier', async () => {
    const output = await compile('android-test', {
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_ship',
      VITE_SUPABASE_ENVIRONMENT: 'test',
    })
    expect(output).not.toContain('sb_secret_do_not_ship')
    expect(output).not.toContain('https://test.supabase.co')
    expect(output).toContain('invalid')
    expect(output).toContain('android-test')
  })

  it('transmet seulement le projet validé et une clé publique aux ressources natives', async () => {
    const output = await compile('production', {
      VITE_SUPABASE_URL: 'https://production.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
      VITE_SUPABASE_ENVIRONMENT: 'production',
      SAMHAIN_SUPABASE_PRODUCTION_URL: 'https://production.supabase.co',
    })
    expect(output).toContain('configured')
    expect(output).toContain('https://production.supabase.co')
    expect(output).not.toContain('VITE_SUPABASE')
    expect(containsPrivilegedCredential(output)).toBe(false)
  })

  it('compile une caisse locale sans configuration', async () => {
    expect(await compile('production', {})).toContain('not_configured')
  })

  it('bloque une clé privilégiée codée en dur et un JWT service_role', async () => {
    await expect(compile('production', {}, 'console.log("sb_secret_hardcoded")')).rejects.toThrow(
      /Credential Supabase privilégié/,
    )
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`
    expect(containsPrivilegedCredential(token)).toBe(true)
    await expect(compile('production', {}, `console.log("${token}")`)).rejects.toThrow(
      /Credential Supabase privilégié/,
    )
    expect(containsPrivilegedCredential('eyJheader.invalid.signature')).toBe(false)
  })
})
