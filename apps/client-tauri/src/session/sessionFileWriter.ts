import { invoke } from "@tauri-apps/api/core";
import type { SessionRecord, TranscriptEvent } from "@ludo/transcript-schema";

interface NativeWriteResponse {
  sessionDir: string;
  sessionJsonPath: string;
  eventsJsonlPath: string;
  transcriptMdPath: string;
}

export interface SessionWriteResult {
  persisted: boolean;
  message: string;
  sessionDir?: string;
  sessionJsonPath?: string;
  eventsJsonlPath?: string;
  transcriptMdPath?: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    };
    __TAURI__?: {
      core?: {
        invoke?: unknown;
      };
    };
  }
}

function isDesktopTauriRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (typeof window.__TAURI_INTERNALS__?.invoke === "function") {
    return true;
  }

  if (typeof window.__TAURI__?.core?.invoke === "function") {
    return true;
  }

  return false;
}

export async function writeSessionArtifacts(
  session: SessionRecord,
  events: TranscriptEvent[],
): Promise<SessionWriteResult> {
  if (!isDesktopTauriRuntime()) {
    return {
      persisted: false,
      message: "Desktop file writer is available in Tauri runtime only.",
    };
  }

  try {
    const response = await invoke<NativeWriteResponse>("write_session_artifacts", {
      request: {
        session,
        events,
      },
    });

    return {
      persisted: true,
      message: "Session artifacts written successfully.",
      ...response,
    };
  } catch (error) {
    return {
      persisted: false,
      message: `Failed to write session artifacts: ${String(error)}`,
    };
  }
}
