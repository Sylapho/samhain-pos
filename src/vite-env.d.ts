/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEV_PANEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
