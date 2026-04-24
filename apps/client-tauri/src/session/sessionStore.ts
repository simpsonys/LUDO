import type {
  BackendMode,
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
  backendRuntime: string;
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

function mergeOverlappingText(a: string, b: string): string {
  if (a === b) return a;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;

  // Check for suffix of 'a' matching prefix of 'b'
  const minLen = Math.min(a.length, b.length);
  for (let i = minLen; i > 0; i--) {
    const suffix = a.slice(-i);
    const prefix = b.slice(0, i);
    if (suffix === prefix) {
      return a + b.slice(i);
    }
  }

  // Fallback: just concatenate
  return `${a} ${b}`.trim();
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
      backendRuntime: `${event.state}${event.detail ? ` (${event.detail})` : ""}`,
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
    const isMic = session.source === "mic" || session.source === "system";
    
    if (isMic && current.finalSegments.length > 0) {
      const lastIndex = current.finalSegments.length - 1;
      const last = current.finalSegments[lastIndex];
      const timeDiff = event.startMs && last.endMs ? event.startMs - last.endMs : 0;
      
      // If the segments are close in time and the previous doesn't end with strong punctuation, merge them
      const endsWithPunctuation = /[.!?]$|[다요죠까네]$/.test(last.text.trim());
      
      if (timeDiff < 2000 && !endsWithPunctuation) {
        const mergedSegment = {
          ...last,
          text: mergeOverlappingText(last.text, event.text),
          endMs: event.endMs,
        };
        
        const updatedFinalSegments = [...current.finalSegments];
        updatedFinalSegments[lastIndex] = mergedSegment;

        return {
          ...current,
          session,
          events,
          interimText: "",
          finalSegments: updatedFinalSegments,
        };
      }
    }

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
      backendRuntime: current.backendRuntime.startsWith("error") ? "error" : "completed",
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
