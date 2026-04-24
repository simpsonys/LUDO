import type { BackendMode, SessionRecord, StreamHandle, TranscriptEvent } from "@ludo/transcript-schema";

interface ScheduledEvent {
  delayMs: number;
  event: TranscriptEvent;
}



const LIVE_SEGMENTS = [
  "Starting LUDO mock live stream for desktop Phase 1.",
  "Interim and final events are normalized before UI rendering.",
  "Backend abstraction remains provider-neutral while keeping Azure as a future default server backend.",
];

function millisNow(): number {
  return Date.now();
}

function baseSchedule(session: SessionRecord, backend: BackendMode): ScheduledEvent[] {
  const now = millisNow();
  return [
    {
      delayMs: 0,
      event: {
        type: "session_started",
        sessionId: session.sessionId,
        at: now,
        source: session.source,
        backend,
      },
    },
    {
      delayMs: 120,
      event: {
        type: "backend_state",
        sessionId: session.sessionId,
        at: now + 120,
        state: "starting",
        detail: `${backend} initializing`,
      },
    },
    {
      delayMs: 140,
      event: {
        type: "backend_state",
        sessionId: session.sessionId,
        at: now + 260,
        state: "running",
      },
    },
    {
      delayMs: 120,
      event: {
        type: "speech_start",
        sessionId: session.sessionId,
        at: now + 380,
      },
    },
  ];
}

export function buildMockLiveSchedule(
  session: SessionRecord,
  backend: BackendMode,
): ScheduledEvent[] {
  const schedule = baseSchedule(session, backend);

  LIVE_SEGMENTS.forEach((line, index) => {
    const segmentId = `live-${index + 1}`;
    schedule.push({
      delayMs: 420,
      event: {
        type: "interim",
        sessionId: session.sessionId,
        segmentId,
        text: `${line.slice(0, Math.floor(line.length * 0.72))}...`,
      },
    });
    schedule.push({
      delayMs: 340,
      event: {
        type: "final",
        sessionId: session.sessionId,
        segmentId,
        text: line,
      },
    });
  });

  schedule.push({
    delayMs: 260,
    event: {
      type: "speech_end",
      sessionId: session.sessionId,
      at: millisNow() + 260,
    },
  });
  schedule.push({
    delayMs: 100,
    event: {
      type: "backend_state",
      sessionId: session.sessionId,
      at: millisNow() + 360,
      state: "completed",
    },
  });

  return schedule;
}

export function buildAzureServerPlaceholderSchedule(
  session: SessionRecord,
): ScheduledEvent[] {
  const now = millisNow();
  return [
    {
      delayMs: 0,
      event: {
        type: "session_started",
        sessionId: session.sessionId,
        at: now,
        source: session.source,
        backend: "azure_server",
      },
    },
    {
      delayMs: 100,
      event: {
        type: "backend_state",
        sessionId: session.sessionId,
        at: now + 100,
        state: "error",
        detail: "azure_server is a placeholder in this phase",
      },
    },
    {
      delayMs: 100,
      event: {
        type: "error",
        sessionId: session.sessionId,
        at: now + 200,
        message:
          "Azure SDK path is not integrated yet. Use local_gpu or local_cpu for file transcription.",
      },
    },
  ];
}

export function buildStagedReplaySchedule(
  events: TranscriptEvent[],
  firstDelayMs = 80,
  stepDelayMs = 170,
): ScheduledEvent[] {
  return events.map((event, index) => ({
    delayMs: index === 0 ? firstDelayMs : stepDelayMs,
    event,
  }));
}

export function runScheduledEvents(
  schedule: ScheduledEvent[],
  onEvent: (event: TranscriptEvent) => void,
): StreamHandle {
  let cancelled = false;
  let settled = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let doneResolve: (state: "completed" | "stopped") => void = () => undefined;

  const done = new Promise<"completed" | "stopped">((resolve) => {
    doneResolve = resolve;
  });

  const finish = (state: "completed" | "stopped") => {
    if (settled) {
      return;
    }
    settled = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    doneResolve(state);
  };

  const pump = () => {
    if (cancelled) {
      finish("stopped");
      return;
    }

    if (index >= schedule.length) {
      finish("completed");
      return;
    }

    const next = schedule[index];
    index += 1;

    timer = setTimeout(() => {
      if (cancelled) {
        finish("stopped");
        return;
      }

      onEvent(next.event);
      pump();
    }, next.delayMs);
  };

  pump();

  return {
    stop() {
      cancelled = true;
      finish("stopped");
    },
    done,
  };
}
