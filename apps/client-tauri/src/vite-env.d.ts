/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LUDO_SERVER_ASR_BASE_URL?: string;
  readonly VITE_LUDO_SERVER_ASR_API_KEY?: string;
  readonly VITE_LUDO_AZURE_SERVER_FILE_PATH?: string;
  readonly VITE_LUDO_AZURE_SERVER_MIC_CHUNK_PATH?: string;
  readonly VITE_LUDO_SERVER_ASR_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
