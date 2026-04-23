import type { BackendMode, SessionRecord, TranscriptEvent } from "@ludo/transcript-schema";
import {
  buildMockLiveSchedule,
  buildStagedReplaySchedule,
  runScheduledEvents,
  type StreamHandle,
} from "./mockPipeline";
import { startMicrophoneChunkedSession } from "./microphonePipeline";
import { runPythonFileTranscription } from "./pythonWorkerClient";
import { createServerAsrAdapter } from "./serverAsrAdapter";

export type { StreamHandle } from "./mockPipeline";

export const BACKEND_MODES: BackendMode[] = ["local_gpu", "local_cpu", "azure_server"];

export interface FileTranscriptionRequest {
  session: SessionRecord;
  file: File;
}

export type TranscriptSink = (event: TranscriptEvent) => void;

export interface AsrBackendAdapter {
  mode: BackendMode;
  transcribeFile: (request: FileTranscriptionRequest, sink: TranscriptSink) => StreamHandle;
  startMicrophoneSession: (session: SessionRecord, sink: TranscriptSink) => StreamHandle;
  startMockLive: (session: SessionRecord, sink: TranscriptSink) => StreamHandle;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createBackendConfigErrorStream(
  session: SessionRecord,
  message: string,
  sink: TranscriptSink,
): StreamHandle {
  const now = Date.now();
  return runScheduledEvents(
    [
      {
        delayMs: 0,
        event: {
          type: "session_started",
          sessionId: session.sessionId,
          at: now,
          source: session.source,
          backend: session.backend,
        },
      },
      {
        delayMs: 50,
        event: {
          type: "backend_state",
          sessionId: session.sessionId,
          at: now + 50,
          state: "error",
          detail: "backend configuration invalid",
        },
      },
      {
        delayMs: 50,
        event: {
          type: "error",
          sessionId: session.sessionId,
          message,
        },
      },
    ],
    sink,
  );
}

function createDeferredStream(
  job: Promise<StreamHandle>,
  sessionId: string,
  sink: TranscriptSink,
): StreamHandle {
  let cancelled = false;
  let activeHandle: StreamHandle | null = null;
  let settled = false;
  let doneResolve: (state: "completed" | "stopped") => void = () => undefined;

  const done = new Promise<"completed" | "stopped">((resolve) => {
    doneResolve = resolve;
  });

  const settle = (state: "completed" | "stopped") => {
    if (settled) {
      return;
    }
    settled = true;
    doneResolve(state);
  };

  void job
    .then((handle) => {
      if (cancelled) {
        handle.stop();
        void handle.done.then((state) => settle(state));
        return;
      }

      activeHandle = handle;
      void handle.done.then((state) => settle(state));
    })
    .catch((error) => {
      if (!cancelled) {
        sink({
          type: "error",
          sessionId,
          message: `Backend invocation failed: ${String(error)}`,
        });
      }
      settle(cancelled ? "stopped" : "completed");
    });

  return {
    stop() {
      cancelled = true;
      if (activeHandle) {
        activeHandle.stop();
        return;
      }
      settle("stopped");
    },
    done,
  };
}

export function createBackendAdapter(mode: BackendMode): AsrBackendAdapter {
  const serverAdapter = mode === "azure_server" ? createServerAsrAdapter(mode) : null;

  return {
    mode,
    transcribeFile(request, sink) {
      if (mode === "azure_server" && serverAdapter) {
        try {
          serverAdapter.validateConfig();
        } catch (error) {
          return createBackendConfigErrorStream(
            request.session,
            toErrorMessage(error),
            sink,
          );
        }
      }

      const job = (async () => {
        const workerResult =
          mode === "azure_server" && serverAdapter
            ? await serverAdapter.transcribeFile({
                session: request.session,
                file: request.file,
              })
            : await (async () => {
                const fileBuffer = await request.file.arrayBuffer();
                const fileBytes = Array.from(new Uint8Array(fileBuffer));

                return runPythonFileTranscription({
                  session: request.session,
                  backend: mode,
                  source: request.session.source,
                  inputFileName: request.file.name,
                  inputFileBytes: fileBytes,
                });
              })();

        return runScheduledEvents(buildStagedReplaySchedule(workerResult.events), sink);
      })();

      return createDeferredStream(job, request.session.sessionId, sink);
    },
    startMicrophoneSession(session, sink) {
      if (mode === "azure_server" && serverAdapter) {
        try {
          serverAdapter.validateConfig();
        } catch (error) {
          return createBackendConfigErrorStream(session, toErrorMessage(error), sink);
        }
      }

      const job = startMicrophoneChunkedSession(
        {
          session,
          backend: mode,
        },
        sink,
        mode === "azure_server" && serverAdapter
          ? {
              transcribeChunk: (request) => serverAdapter.transcribeMicrophoneChunk(request),
            }
          : undefined,
      );

      return createDeferredStream(job, session.sessionId, sink);
    },
    startMockLive(session, sink) {
      return runScheduledEvents(buildMockLiveSchedule(session, mode), sink);
    },
  };
}
