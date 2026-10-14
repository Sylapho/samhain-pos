import type { Plugin } from 'vite'
import {
  resolveSupabaseConfiguration,
  type SupabaseBuildEnvironment,
} from '../src/config/supabase.ts'

export function containsPrivilegedCredential(content: string): boolean {
  if (/sb_secret_[A-Za-z0-9_-]+/.test(content)) return true
  for (const match of content.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role')
        return true
    } catch {
      // Ignore code fragments which do not decode to a JWT payload.
    }
  }
  return false
}

export function supabaseBuildConfiguration(mode: string, environment: SupabaseBuildEnvironment) {
  const supabase = resolveSupabaseConfiguration(mode, environment)
  return {
    // Raw VITE_* values must never be exposed, even through an import.meta.env object spread.
    envPrefix: [],
    define: {
      __SUPABASE_CONFIGURATION__: JSON.stringify(supabase),
      'import.meta.env.VITE_ENABLE_DEV_PANEL': JSON.stringify(
        mode !== 'production' && environment.VITE_ENABLE_DEV_PANEL === 'true' ? 'true' : 'false',
      ),
    },
    plugins: [
      {
        name: 'samhain-public-build-configuration',
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            const content =
              output.type === 'chunk'
                ? output.code
                : typeof output.source === 'string'
                  ? output.source
                  : Buffer.from(output.source).toString('utf8')
            if (containsPrivilegedCredential(content)) {
              this.error('Credential Supabase privilégié interdit dans les ressources compilées.')
            }
          }
          this.emitFile({
            type: 'asset',
            fileName: 'samhain-build.json',
            source: JSON.stringify({ schemaVersion: 1, mode, supabase }),
          })
        },
      } satisfies Plugin,
    ],
  }
}
