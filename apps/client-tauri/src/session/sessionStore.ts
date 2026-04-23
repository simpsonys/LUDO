import type {
  BackendMode,
  BackendRuntimeState,
  SessionLanguage,
  SessionRecord,
  SessionSnapshot,
  SessionSource,
  TranscriptEvent,
} from "@ludo/transcript-schema";

export interface FinalSegment {
  segmentId: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface SessionState {
  session: SessionRecord;
  events: TranscriptEvent[];
  finalSegments: FinalSegment[];
  interimText: string;
  backendRuntime: BackendRuntimeState;
  startedAt?: number;
  endedAt?: number;
  lastError?: string;
}

export interface SessionSeed {
  source?: SessionSource;
  backend?: BackendMode;
  language?: SessionLanguage;
  computeType?: string;
  title?: string;
  inputFileName?: string;
  inputFileBytes?: number;
}

export function createSessionRecord(seed: SessionSeed = {}): SessionRecord {
  const now = Date.now();
  const date = new Date(now);
  const source = seed.source ?? "file";
  const backend = seed.backend ?? "local_gpu";

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const sessionId = `session-${yyyy}${mm}${dd}_${hh}${min}_${ss}`;

  return {
    sessionId,
    title: seed.title ?? `LUDO Session ${date.toISOString()}`,
    createdAt: now,
    updatedAt: now,
    source,
    backend,
    language: seed.language ?? "auto",
    status: "idle",
    computeType: seed.computeType,
    inputFileName: seed.inputFileName,
    inputFileBytes: seed.inputFileBytes,
  };
}

export function createInitialSessionState(
  session: SessionRecord = createSessionRecord(),
): SessionState {
  return {
    session,
    events: [],
    finalSegments: [],
    interimText: "",
    backendRuntime: "idle",
  };
}

export function applyTranscriptEvent(
  current: SessionState,
  event: TranscriptEvent,
): SessionState {
  const session = { ...current.session, updatedAt: Date.now() };
  const events = [...current.events, event];

  if (event.type === "session_started") {
    session.status = "running";
    return {
      ...current,
      session,
      events,
      startedAt: event.at,
      endedAt: undefined,
      backendRuntime: "starting",
      lastError: undefined,
    };
  }

  if (event.type === "backend_state") {
    return {
      ...current,
      session,
      events,
      backendRuntime: event.state,
    };
  }

  if (event.type === "interim") {
    return {
      ...current,
      session,
      events,
      interimText: event.text,
    };
  }

  if (event.type === "final") {
    return {
      ...current,
      session,
      events,
      interimText: "",
      finalSegments: [
        ...current.finalSegments,
        {
          segmentId: event.segmentId,
          text: event.text,
          startMs: event.startMs,
          endMs: event.endMs,
        },
      ],
    };
  }

  if (event.type === "speech_end") {
    session.status = "stopped";
    return {
      ...current,
      session,
      events,
      interimText: "",
      endedAt: event.at,
      backendRuntime: current.backendRuntime === "error" ? "error" : "completed",
    };
  }

  if (event.type === "error") {
    session.status = "error";
    return {
      ...current,
      session,
      events,
      backendRuntime: "error",
      lastError: event.message,
    };
  }

  return {
    ...current,
    session,
    events,
  };
}

export function toSessionSnapshot(current: SessionState): SessionSnapshot {
  return {
    session: current.session,
    events: current.events,
  };
}

export function hydrateSessionState(snapshot: SessionSnapshot): SessionState {
  const hydrated = createInitialSessionState(snapshot.session);
  return snapshot.events.reduce(
    (state, event) => applyTranscriptEvent(state, event),
    hydrated,
  );
}
