import type { SupabaseConfiguration } from './supabase'

// Injected by Vite, also packaged as public/samhain-build.json for the native worker.
export const supabaseConfiguration: SupabaseConfiguration = __SUPABASE_CONFIGURATION__
