/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { assertReceiptBusinessInfoReadyForProduction } from './src/config/organization.ts'

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') {
    try {
      assertReceiptBusinessInfoReadyForProduction()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Configuration inconnue.'
      throw new Error(`Build de production bloqué. ${message}`)
    }
  }

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
