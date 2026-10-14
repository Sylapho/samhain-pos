import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'fr.samhain.pos',
  appName: 'Samhain POS',
  webDir: 'dist',
  // Capacitor otherwise logs plugin parameters, including enrollment credentials.
  loggingBehavior: 'none',
  android: {
    backgroundColor: '#111827',
  },
}

export default config
