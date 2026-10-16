/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute URL of the game server. Blank = same origin (recommended). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
