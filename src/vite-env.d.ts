/// <reference types="vite/client" />

declare const __SUPABASE_CONFIGURATION__: import('./config/supabase').SupabaseConfiguration
declare const __TABLET_API_CONFIGURATION__: import('./config/apiAuth').ApiAuthConfiguration

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEV_PANEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
