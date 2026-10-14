/// <reference types="vite/client" />

declare const __SUPABASE_CONFIGURATION__: import('./config/supabase').SupabaseConfiguration

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEV_PANEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
