export type SessionSource = "mic" | "system" | "file";

export type BackendMode = "local_gpu" | "local_cpu" | "azure_server";

export type SessionLanguage = "ko" | "en" | "auto";

export type SessionStatus = "idle" | "running" | "stopped" | "error";

export type BackendRuntimeState = "idle" | "starting" | "running" | "completed" | "error";

export interface SessionRecord {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  source: SessionSource;
  backend: BackendMode;
  language: SessionLanguage;
  status: SessionStatus;
  inputFileName?: string;
  inputFileBytes?: number;
}

export type ArtifactKind =
  | "transcript"
  | "meeting_minutes"
  | "action_items"
  | "explain_like_im_new";

export type SyncState = "queued" | "running" | "done" | "error";

export type TranscriptEvent =
  | {
      type: "session_started";
      sessionId: string;
      at: number;
      source: SessionSource;
      backend: BackendMode;
    }
  | {
      type: "backend_state";
      sessionId: string;
      at: number;
      state: BackendRuntimeState;
      detail?: string;
    }
  | {
      type: "speech_start";
      sessionId: string;
      at: number;
    }
  | {
      type: "interim";
      sessionId: string;
      segmentId: string;
      text: string;
      startMs?: number;
      endMs?: number;
    }
  | {
      type: "final";
      sessionId: string;
      segmentId: string;
      text: string;
      startMs?: number;
      endMs?: number;
    }
  | {
      type: "speech_end";
      sessionId: string;
      at: number;
    }
  | {
      type: "artifact_generated";
      sessionId: string;
      artifact: ArtifactKind;
      path: string;
    }
  | {
      type: "sync_status";
      sessionId: string;
      state: SyncState;
      detail?: string;
    }
  | {
      type: "error";
      sessionId: string;
      message: string;
    };

export interface SessionSnapshot {
  session: SessionRecord;
  events: TranscriptEvent[];
}
