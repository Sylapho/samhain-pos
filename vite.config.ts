/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { assertProductionBuildReady } from './src/config/production.ts'

export default defineConfig(({ command, mode }) => {
  assertProductionBuildReady({ command, mode })

  return {
    plugins: [react(), tailwindcss()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      css: true,
    },
  }
})
