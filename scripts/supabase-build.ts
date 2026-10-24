import type { Plugin } from 'vite'
import { resolveApiAuthConfiguration } from '../src/config/apiAuth.ts'
import {
  resolveSupabaseConfiguration,
  type SupabaseBuildEnvironment,
} from '../src/config/supabase.ts'

export function containsPrivilegedCredential(content: string): boolean {
  if (/sb_secret_[A-Za-z0-9_-]+/.test(content)) return true
  if (/mongodb(?:\+srv)?:\/\/|-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(content))
    return true
  for (const match of content.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
      if (payload.role === 'service_role' || (payload.sub && payload.exp)) return true
    } catch {
      // Ignore code fragments which do not decode to a JWT payload.
    }
  }
  return false
}

export function supabaseBuildConfiguration(mode: string, environment: SupabaseBuildEnvironment) {
  const supabase = resolveSupabaseConfiguration(mode, environment)
  const apiAuth = resolveApiAuthConfiguration(mode, environment)
  if (apiAuth.status === 'invalid')
    throw new Error('Configuration API invalide ou destination de production non confirmée.')
  return {
    // Raw VITE_* values must never be exposed, even through an import.meta.env object spread.
    envPrefix: [],
    define: {
      __SUPABASE_CONFIGURATION__: JSON.stringify(supabase),
      __TABLET_API_CONFIGURATION__: JSON.stringify(apiAuth),
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
              this.error(
                'Secret serveur ou credential de session interdit dans les ressources compilées.',
              )
            }
          }
          this.emitFile({
            type: 'asset',
            fileName: 'samhain-build.json',
            source: JSON.stringify({ schemaVersion: 1, mode, supabase, apiAuth }),
          })
        },
      } satisfies Plugin,
    ],
  }
}
