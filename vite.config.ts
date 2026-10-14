/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { assertProductionBuildReady } from './src/config/production.ts'
import { supabaseBuildConfiguration } from './scripts/supabase-build.ts'

export default defineConfig(({ command, mode }) => {
  assertProductionBuildReady({ command, mode })
  const sync = supabaseBuildConfiguration(mode, loadEnv(mode, process.cwd(), ''))

  return {
    ...sync,
    plugins: [react(), tailwindcss(), ...sync.plugins],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      css: true,
    },
  }
})
